import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

function environmentValue(environment, name, platform) {
  const key = Object.keys(environment).find(key => platform === 'win32'
    ? key.toUpperCase() === name.toUpperCase() : key === name);
  return key ? environment[key] : undefined;
}

async function executableFile(file) {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch { return false; }
}

export async function resolveDocker({ environment = process.env, platform = process.platform, isExecutable = executableFile } = {}) {
  const paths = platform === 'win32' ? win32 : posix;
  const delimiter = platform === 'win32' ? ';' : ':';
  const originalPath = environmentValue(environment, 'PATH', platform) ?? '';
  const override = environmentValue(environment, 'TSS_DOCKER_EXE', platform);
  let command;
  if (override) {
    if (!paths.isAbsolute(override) || !(await isExecutable(override))) {
      throw new Error('TSS_DOCKER_EXE must point to an existing Docker executable using an absolute path.');
    }
    command = override;
  } else {
    const candidates = originalPath.split(delimiter).filter(Boolean)
      .map(directory => paths.join(directory.replace(/^"(.*)"$/, '$1'), platform === 'win32' ? 'docker.exe' : 'docker'));
    if (platform === 'win32') {
      const local = environmentValue(environment, 'LOCALAPPDATA', platform);
      const programFiles = environmentValue(environment, 'ProgramFiles', platform);
      if (local) candidates.push(paths.join(local, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe'));
      if (programFiles) candidates.push(paths.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe'));
    }
    for (const candidate of candidates) {
      if (paths.isAbsolute(candidate) && await isExecutable(candidate)) { command = candidate; break; }
    }
  }
  if (!command) throw new Error('Docker CLI not found or not accessible. Check the installation and Codex execution permissions, or set TSS_DOCKER_EXE to its absolute executable path.');

  // Docker credential helpers also need the installation directory on the child PATH.
  const childEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => platform === 'win32' ? key.toUpperCase() !== 'PATH' : key !== 'PATH'));
  childEnvironment.PATH = [paths.dirname(command), originalPath].filter(Boolean).join(delimiter);
  return { command, environment: childEnvironment };
}

export function localDockerTarget({ context, contextEndpoint, environment = process.env, platform = process.platform }) {
  const hostOverride = environmentValue(environment, 'DOCKER_HOST', platform);
  const contextOverride = environmentValue(environment, 'DOCKER_CONTEXT', platform);
  const useHost = Boolean(hostOverride && !contextOverride);
  const endpoint = useHost ? hostOverride : contextEndpoint;
  let local = /^npipe:\/\/\/\/\.\/pipe\/[^\s]+$/.test(endpoint ?? '');
  try {
    const url = new URL(endpoint);
    local ||= !url.username && !url.password && !url.search && !url.hash && (
      (url.protocol === 'unix:' && !url.hostname && url.pathname.startsWith('/')) ||
      (url.protocol === 'tcp:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    );
  } catch { /* Named pipes are checked separately above. */ }
  if (!local) throw new Error('Local staging requires a local Docker endpoint. Select your local Docker Desktop context and remove remote DOCKER_HOST/DOCKER_CONTEXT overrides.');
  if (!useHost && !context) throw new Error('Could not identify the local Docker context.');
  return { args: useHost ? ['--host', endpoint] : ['--context', context], endpoint, context: useHost ? '(DOCKER_HOST)' : context };
}

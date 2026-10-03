# TSS Gestão — migração local de JSON para PostgreSQL

Esta alteração permite escolher PostgreSQL para guardar clientes, serviços, propostas, parque, oficina, documentos internos, utilizadores, configuração e auditoria. A interface e as regras de aprovação continuam a funcionar através do mesmo servidor Node.js. A migração conserva identificadores, referências, versões, datas, palavras-passe derivadas e restantes campos; não cria novas contas nem altera a palavra-passe de Sergiu.

O modo JSON continua disponível para o piloto. A aplicação só usa PostgreSQL quando `STORAGE_BACKEND=postgres` é definido explicitamente. Se a ligação PostgreSQL falhar, o arranque termina com erro: não muda silenciosamente para o ficheiro JSON.

## 1. Preparar o computador

1. Instale uma versão suportada de PostgreSQL pelo [instalador para Windows indicado pelo projeto PostgreSQL](https://www.postgresql.org/download/windows/). O instalador disponibiliza o servidor e o pgAdmin. Guarde a palavra-passe do administrador `postgres` e confirme a porta, normalmente `5432`.
2. Confirme que o serviço PostgreSQL está a funcionar. A configuração abaixo mantém a base de dados neste computador, em `127.0.0.1`.
3. Abra a pasta `tss-tracker` no Visual Studio Code e instale os pacotes com o iniciador incluído:

```powershell
.\Instalar-dependencias.cmd
```

Este iniciador usa npm quando está disponível; neste computador também consegue usar o pnpm incluído no runtime do Codex. Se tiver Node.js e npm no PATH, pode usar os comandos habituais:

```powershell
node --version
npm --version
npm install
```

O pacote `pg` permite ao servidor Node.js comunicar com PostgreSQL. Não é necessário mudar para outro framework nem reescrever a interface. A configuração da ligação e o conjunto de ligações seguem as capacidades do [node-postgres](https://node-postgres.com/features/connecting).

Se `node` ou `npm` não forem reconhecidos, use os iniciadores incluídos ou instale Node.js com npm e volte a abrir o terminal. `Iniciar-TSS.cmd` também encontra o Node incluído no Codex neste computador.

## 2. Criar uma conta técnica e uma base de dados dedicadas

Abra **SQL Shell (psql)** do PostgreSQL, ou execute este comando quando `psql` estiver no PATH:

```powershell
psql -h 127.0.0.1 -U postgres -d postgres -W
```

Depois execute, dentro de psql:

```sql
CREATE ROLE tss_app LOGIN;
\password tss_app
CREATE DATABASE tss_gestao OWNER tss_app;
\connect tss_gestao
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
\quit
```

`\password` pede uma palavra-passe nova sem a escrever no comando SQL. Escolha uma palavra-passe única. Estes comandos pressupõem que os nomes ainda não existem; se já existirem, confirme a configuração existente em vez de apagar a base de dados.

`tss_app` é uma conta técnica de base de dados. Sergiu e os restantes colaboradores continuam a entrar com as suas contas da aplicação e respetivas funções; não recebem esta credencial técnica. O papel não precisa de privilégios de superutilizador, `CREATEROLE` nem `CREATEDB`. Neste piloto, é proprietário da sua base de dados para poder criar o esquema `tss` e aplicar as migrações de tabelas. Para produção, deve separar-se a conta que aplica migrações da conta de execução com permissões limitadas.

## 3. Configurar a ligação

Se ainda não existir um ficheiro `.env`, copie o exemplo no terminal do VS Code:

```powershell
Copy-Item -LiteralPath .env.example -Destination .env
```

Edite o ficheiro `.env` e substitua a palavra-passe ilustrativa pela que acabou de definir:

```dotenv
STORAGE_BACKEND=json
DATABASE_URL=postgresql://tss_app:SUBSTITUIR_POR_PALAVRA_PASSE@127.0.0.1:5432/tss_gestao
PORT=4317
```

Mantenha inicialmente `STORAGE_BACKEND=json`, enquanto valida e importa os registos. O comando de importação usa `DATABASE_URL` independentemente do modo de arranque.

Codifique caracteres especiais da palavra-passe no formato URL: `@` corresponde a `%40`, `#` a `%23`, `:` a `%3A`, `/` a `%2F` e `%` a `%25`. Não envie a palavra-passe a serviços online para a converter. `.env` não deve ser publicado nem partilhado; está excluído do controlo de versões. Variáveis já definidas no terminal prevalecem sobre `.env`.

O carregador aceita linhas `NOME=valor`, comentários iniciados por `#` e valores entre aspas simples ou duplas. Não executa comandos, não expande outras variáveis e não suporta valores em várias linhas. Nomes repetidos ou linhas mal formadas interrompem o carregamento. As credenciais não são apresentadas nas mensagens da migração.

## 4. Validar o ficheiro atual sem importar

Na pasta `tss-tracker`, execute:

```powershell
npm run db:migrate
```

Quando `node` está no PATH, o comando equivalente é:

```powershell
node tools/postgres-migrate.mjs
```

Neste computador, se não estiver no PATH, pode usar diretamente o runtime existente. Defina uma variável só para este terminal:

```powershell
$tssNode = 'C:\Users\sandu\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
& $tssNode tools/postgres-migrate.mjs
```

Este é o modo de simulação predefinido. Lê `data/jobs.json`, valida a estrutura e mostra apenas contagens por coleção, versões de esquema e a impressão SHA-256 do ficheiro. Não liga a PostgreSQL, não escreve na base de dados e não cria cópias nem altera a origem.

Para outra origem:

```powershell
npm run db:migrate -- --source "C:\caminho\para\jobs.json"
```

O ficheiro tem de existir e conter dados válidos. Um ficheiro inexistente, inválido ou com credenciais mal formadas interrompe a migração; não é substituído por dados de exemplo.

Os ficheiros atuais da versão 2 são preservados integralmente. Se a origem for antiga, da versão 1, a preparação atualiza o esquema apenas em memória, como a migração original da aplicação: cria clientes a partir dos nomes existentes, preserva o pagamento antigo em `legacyPaymentStatus` e adiciona metadados de migração. Não altera o ficheiro antigo nem inventa contas, comprovativos, recebimentos ou documentos financeiros. Numa versão 2 anterior aos automatismos, inicializa apenas a configuração em falta e o respetivo evento de auditoria.

## 5. Importar com o servidor parado

1. Termine todas as instâncias do servidor TSS que usam a origem JSON, com **Ctrl+C** nos respetivos terminais. Feche trabalhos de edição direta desse ficheiro.
2. Confirme as contagens da simulação e que `tss_gestao` é a base de dados dedicada pretendida.
3. Execute:

```powershell
npm run db:migrate -- --apply
```

As alternativas diretas são `node tools/postgres-migrate.mjs --apply` ou, com a variável anterior, `& $tssNode tools/postgres-migrate.mjs --apply`.

O comando cria e verifica primeiro uma cópia exata dos bytes da origem, com nome semelhante a `data/jobs.json.postgres-backup-DATA-HORA-identificador.json`. Só depois tenta ligar a PostgreSQL e aplicar as migrações de esquema. Guarde esta cópia com acesso controlado: contém dados empresariais e credenciais derivadas.

Os registos são importados numa única transação. A importação recusa um destino já inicializado ou que contenha registos, incluindo uma importação anterior concluída. Não existe opção de sobrescrita. Repetir o comando não duplica os dados nem apaga o destino; pode criar outra cópia de segurança da origem antes de detetar que o destino já tem dados.

A verificação compara todos os campos e todas as coleções preparados com os dados relidos da base de dados, incluindo identificadores, hashes e parâmetros das palavras-passe, versões, configuração, contadores, ordem dos registos e metadados. A comparação integral dentro da transação tem de passar antes da confirmação. Uma falha de importação reverte os registos dessa transação; as tabelas vazias já criadas pelas migrações de esquema podem permanecer. A origem JSON é conservada.

O comando não elimina nem repõe bases de dados. Se a origem mudar durante a preparação, recusa a operação. É essencial manter o servidor JSON parado durante todo o processo.

## 6. Iniciar com PostgreSQL

Depois de a importação concluir e verificar os dados, altere em `.env`:

```dotenv
STORAGE_BACKEND=postgres
```

Execute:

```powershell
npm start
```

Também pode executar `.\Iniciar-TSS.cmd` ou `node server.mjs`. O servidor carrega `.env` automaticamente.

Abra **http://127.0.0.1:4317** e entre com a conta existente. Confirme clientes e serviços, consulte a configuração dos automatismos e valide um fluxo de trabalho de teste. Termine e reinicie o servidor para confirmar a persistência.

A base de dados vazia não recebe amostras automaticamente no modo PostgreSQL. Tem de ser inicializada pelo comando de importação antes do arranque. Se a origem validada não tiver contas, o primeiro acesso mantém o processo normal de criação do primeiro gerente.

A partir desta mudança, os novos registos ficam em PostgreSQL. `data/jobs.json` mantém apenas a fotografia anterior à migração; voltar a `STORAGE_BACKEND=json` não transfere para o ficheiro as alterações feitas na base de dados. Para um ensaio de regresso ao modo anterior, termine a aplicação e tenha presente que só verá os dados antigos. Conserve uma cópia PostgreSQL e reconcilie alterações antes de um regresso operacional.

## 7. Cópias de segurança após a migração

Uma cópia do JSON deixa de ser suficiente para guardar o trabalho novo. Para uma cópia local PostgreSQL em formato próprio, quando `pg_dump` estiver no PATH:

```powershell
pg_dump -h 127.0.0.1 -U tss_app -d tss_gestao -W -Fc -f "tss_gestao-backup.dump"
```

Escolha um nome diferente por execução e guarde as cópias fora da pasta de trabalho, com acesso controlado. O parâmetro `-W` pede a palavra-passe; não a inclua no comando. `pg_dump` produz uma fotografia consistente da base de dados, conforme a [documentação PostgreSQL](https://www.postgresql.org/docs/current/backup-dump.html). Teste o restauro numa base de dados separada antes de confiar num procedimento de cópias.

## 8. Estrutura e limites desta etapa

Cada coleção passa a ter uma tabela no esquema `tss`. Cada registo ocupa a sua linha e conserva os seus campos numa coluna `jsonb`; identificadores, versões e campos de ligação/consulta também têm colunas próprias conforme a migração SQL. Contadores e configuração continuam em metadados separados. Isto permite migrar sem perder campos da aplicação atual e introduz transações reais e restrições de unicidade no destino.

Esta é uma adaptação intermédia, não uma reescrita integral para consultas SQL por módulo. A lógica atual continua a ler o conjunto de registos para validar os fluxos; alterações concorrentes são coordenadas por um bloqueio transacional global. O custo das leituras aumenta com o volume, e as alterações são serializadas. Para milhares de utilizadores e grandes volumes, a próxima etapa deve introduzir repositórios e consultas por entidade, paginação, índices adequados às pesquisas, transações com bloqueios mais específicos e medições de carga.

As sessões de autenticação e os limites de tentativas continuam na memória do processo Node.js. Reiniciar o servidor termina as sessões. Para várias instâncias partilhadas, falta um armazenamento de sessões/limites comum ou outro mecanismo de coordenação equivalente. A aplicação continua a escutar apenas em `127.0.0.1`; esta migração não publica um serviço na internet, não acrescenta MFA nem integra faturação fiscal certificada.

## 9. Verificação técnica

Depois de instalar também as dependências de desenvolvimento, execute:

```powershell
npm test
```

Sem npm no PATH, use `node --test tests/*.test.mjs` ou `& $tssNode --test tests/*.test.mjs`.

Os testes do comando de migração usam ficheiros temporários e um destino simulado para verificar a simulação sem escritas, cópia exata antes de ligar ao destino, preservação dos campos e credenciais, recusas, fecho das ligações e configuração `.env`. Não alteram `data/jobs.json`.

Os testes de SQL embebido usam PGlite, um motor PostgreSQL local dentro do processo de teste, para verificar as tabelas, restrições, importação e transações. Estes testes ajudam a validar o SQL; não demonstram que um serviço PostgreSQL externo esteja instalado, nem validam ligação de rede, autenticação PostgreSQL, TLS ou bloqueios entre várias sessões/processos.

Os testes de integração com um servidor PostgreSQL externo só executam quando `TSS_TEST_DATABASE_URL` está definida no ambiente. Prepare uma **base de dados dedicada exclusivamente a testes**, com uma conta técnica que possa criar e eliminar esquemas nessa base. Depois execute:

```powershell
$env:TSS_TEST_DATABASE_URL = 'postgresql://UTILIZADOR_TESTE:PALAVRA_PASSE_CODIFICADA@127.0.0.1:5432/BASE_DE_TESTE'
npm run test:postgres
```

Sem npm, use `node --test tests/postgres*.test.mjs` ou `& $tssNode --test tests/postgres*.test.mjs`. Nunca configure esta variável com a base operacional. Cada teste externo usa um esquema temporário restrito `tss_test_…` e elimina apenas esse esquema no fim. Sem a variável, estes cenários externos são apresentados como ignorados, com a razão indicada; uma verificação embebida não substitui a execução destes cenários antes de produção.

## Diagnóstico

| Mensagem ou sintoma | Verificação |
| --- | --- |
| `node`, `npm` ou `psql` não reconhecido | Instalação, PATH e novo terminal; SQL Shell também disponibiliza psql |
| Origem JSON inexistente ou inválida | Confirme `--source` e restaure uma cópia válida sem substituir a única origem |
| Ligação recusada / `ECONNREFUSED` | Serviço PostgreSQL, endereço `127.0.0.1` e porta de `.env` |
| Autenticação PostgreSQL recusada | Nome `tss_app`, palavra-passe e codificação URL dos caracteres especiais |
| Permissões insuficientes | Conta técnica deve ser proprietária da base dedicada ou ter as permissões equivalentes para o esquema e migrações |
| Destino já contém registos | Não repita como sobrescrita; confirme a importação concluída ou use uma nova base de dados vazia criada por si |
| Arranque indica destino não inicializado | Execute primeiro a importação com `--apply` numa base dedicada vazia |
| `EADDRINUSE` ao arrancar TSS | Outra instância usa a porta 4317; termine-a ou use a instância existente |

Para consultar os argumentos disponíveis: `npm run db:migrate -- --help`.

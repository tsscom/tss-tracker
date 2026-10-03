"""Create certificates for an explicitly configured local phone validation network.

Never installs certificates, changes firewall rules or starts a network listener.
Requires Python's cryptography package. Existing keys are never overwritten.
"""
import argparse
import datetime
import ipaddress
from pathlib import Path
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

parser = argparse.ArgumentParser(description='Criar certificados HTTPS para teste local TSS.')
parser.add_argument('--ip', required=True, help='IP privado do computador na mesma rede Wi-Fi dos telemóveis')
parser.add_argument('--directory', type=Path, default=Path(__file__).resolve().parents[1] / 'data' / 'tls')
args = parser.parse_args()
address = ipaddress.ip_address(args.ip)
if not address.is_private or address.is_loopback or address.is_unspecified or address.is_multicast:
    parser.error('Indique um IP privado da rede local, diferente de 127.0.0.1.')
directory = args.directory.resolve()
names = ['tss-local-ca-key.pem', 'tss-local-ca.pem', 'tss-local-ca.cer', 'server-key.pem', 'server-cert.pem']
if any((directory / name).exists() for name in names):
    parser.error('Já existem certificados nesta pasta. Preserve-os ou use outra pasta com --directory.')
now = datetime.datetime.now(datetime.timezone.utc)
end = now + datetime.timedelta(days=365)
ca_key = rsa.generate_private_key(public_exponent=65537, key_size=3072)
server_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'TSS Validacao Local CA')])
ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
      .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
      .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(end)
      .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
      .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                  data_encipherment=False, key_agreement=False, key_cert_sign=True,
                                  crl_sign=True, encipher_only=None, decipher_only=None), critical=True)
      .sign(ca_key, hashes.SHA256()))
server_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'TSS Validacao Local')])
server = (x509.CertificateBuilder().subject_name(server_name).issuer_name(ca_name)
          .public_key(server_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - datetime.timedelta(minutes=5)).not_valid_after(end)
          .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
          .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),
                         x509.IPAddress(ipaddress.ip_address('127.0.0.1')), x509.IPAddress(address)]), critical=False)
          .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
          .sign(ca_key, hashes.SHA256()))
directory.mkdir(parents=True, exist_ok=True)
def write(name, content):
    with (directory / name).open('xb') as target:
        target.write(content)
write('tss-local-ca-key.pem', ca_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
write('tss-local-ca.pem', ca.public_bytes(serialization.Encoding.PEM))
write('tss-local-ca.cer', ca.public_bytes(serialization.Encoding.DER))
write('server-key.pem', server_key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
write('server-cert.pem', server.public_bytes(serialization.Encoding.PEM))
print(f'Certificados criados em: {directory}')
print('Instale apenas tss-local-ca.cer nos dispositivos de teste e confirme a confiança nas definições do dispositivo.')
print('Conserve as chaves .pem privadas no computador. Este comando não abre o acesso de rede.')
print(f'Endereço após configurar HTTPS: https://{address}:4317/motorista')

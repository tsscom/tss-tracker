# TSS Gestão — operações e aplicação do motorista

A área **TSS Motorista**, em `/motorista`, é uma aplicação web instalável (PWA) para Android e iPhone. Tem serviços atribuídos, pesquisa, mapas, início de transporte, comprovativo de entrega, fotografia, assinatura e ocorrências. É instalada a partir do navegador; esta entrega não publica uma aplicação na App Store ou Google Play.

## Preparar utilizadores e afetações

1. Sergiu cria uma conta individual em **Utilizadores**, com a função **Motorista**, ou atribui essa função a uma conta existente.
2. No módulo de motoristas, associe o colaborador à sua conta e registe os dados operacionais necessários. No módulo de viaturas, mantenha matrículas, estado e datas operacionais atualizados.
3. Em **TMS**, atribua o serviço à conta desse motorista e à viatura. A indicação de um nome sem associação à conta não permite ao motorista consultar o serviço.
4. Operações autoriza a saída em **Expedir**, depois de resolver incompatibilidades de horário, permanência no parque, bloqueios de oficina, estados e datas operacionais.
5. O motorista abre `/motorista` e entra com a mesma conta. Vê apenas os serviços autorizados pelo servidor e dados operacionais mínimos. Preços, pagamentos e dados financeiros não são guardados na área móvel.

A aplicação móvel não autoriza a própria expedição. **Iniciar transporte** só fica disponível quando existe autorização de saída e os controlos operacionais permitem a ação. Os controlos são repetidos no servidor quando o registo é enviado.

## Validar no computador

Execute a aplicação com `Iniciar-TSS.cmd` ou `node server.mjs` e abra:

```text
http://127.0.0.1:4317/motorista
```

`127.0.0.1` refere-se ao dispositivo que abre a página. No telemóvel esse endereço refere-se ao próprio telemóvel; não é o endereço do computador da TSS.

O servidor continua a escutar apenas no computador por predefinição. A utilização com outros dispositivos exige uma configuração de rede e HTTPS explícita. A instalação e o funcionamento sem ligação dependem de uma ligação segura: os navegadores permitem service workers em HTTPS e, para desenvolvimento no próprio computador, em localhost. [Documentação da API de service workers](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API).

## Preparar HTTPS para um ensaio na mesma rede Wi-Fi

Use esta configuração apenas para os dispositivos que pretende incluir na validação. O computador e os telemóveis têm de conseguir comunicar na mesma rede. O script de certificados não modifica a firewall, não instala certificados nos dispositivos e não publica a aplicação na internet.

1. Consulte o IPv4 privado do computador na ligação Wi-Fi/Ethernet utilizada. O exemplo seguinte usa `192.168.1.50`; substitua-o pelo endereço real.
2. Com Python e o pacote `cryptography` disponíveis, crie o certificado local:

```powershell
python tools/criar-certificado-local.py --ip 192.168.1.50
```

Neste computador também pode usar o Python incluído no runtime do Codex:

```powershell
& 'C:\Users\sandu\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' tools/criar-certificado-local.py --ip 192.168.1.50
```

O script conserva certificados existentes e recusa sobrescrevê-los. Cria os ficheiros na pasta `data/tls`. Guarde as chaves privadas no computador; transfira para os dispositivos de teste apenas `tss-local-ca.cer`, o certificado público da autoridade local.

3. Instale esse certificado nos dispositivos que pretende usar e confirme a confiança segundo as definições do sistema. Num iPhone, a instalação do perfil e a confiança total do certificado são passos distintos. Num Android, o menu de instalação de certificados varia com o fabricante. Um aviso de certificado não é suficiente para tornar a ligação segura: a confiança deve estar configurada e o endereço tem de corresponder ao certificado.
4. Termine a instância atual do servidor. Configure `.env`, conservando o modo de armazenamento escolhido:

```dotenv
HOST=0.0.0.0
ALLOWED_HOSTS=192.168.1.50:4317
TLS_KEY_FILE=data/tls/server-key.pem
TLS_CERT_FILE=data/tls/server-cert.pem
PORT=4317
```

`HOST=0.0.0.0` permite escutar nas interfaces de rede do computador. `ALLOWED_HOSTS` autoriza explicitamente o endereço e a porta usados pelos dispositivos; não inclua `https://` nem `/motorista` nesta variável. Não desative validações de certificado. Se o endereço IP mudar, atualize os certificados e a configuração para o novo endereço.

5. Inicie o servidor. Se a firewall do Windows pedir autorização, limite o acesso à rede privada utilizada neste ensaio. Abra no telemóvel:

```text
https://192.168.1.50:4317/motorista
```

Mantenha o computador e o servidor em execução para consultar dados atuais e enviar registos. O acesso sem ligação permite guardar registos no dispositivo, mas não mantém o servidor em funcionamento nem substitui uma ligação de rede para os enviar.

O acesso de motoristas fora dessa rede é uma etapa de alojamento/rede própria. A configuração acima não permite, por si só, acesso por dados móveis na estrada.

## Instalar em Android

1. Abra o endereço HTTPS da TSS no Chrome ou outro navegador compatível.
2. Entre com a conta individual e confirme que os serviços atribuídos aparecem.
3. Na área **Conta**, toque em **Instalar TSS Motorista**, quando o navegador disponibilizar esse botão. Também pode usar o menu do navegador e escolher **Instalar aplicação** ou **Adicionar ao ecrã principal**.
4. Abra o ícone instalado uma primeira vez com ligação disponível para preparar os ficheiros da aplicação.

A disponibilidade e o texto da opção de instalação variam com o navegador, conforme a [documentação de instalação de PWAs do Google](https://web.dev/learn/pwa/installation).

## Instalar em iPhone

1. Abra o endereço HTTPS no **Safari**.
2. Use **Partilhar → Adicionar ao ecrã principal**. Se aparecer a opção **Abrir como aplicação web**, mantenha-a ativa.
3. Confirme **Adicionar** e abra o ícone **TSS Motorista**.
4. Entre nessa aplicação instalada e carregue os serviços enquanto tem ligação. O navegador e a aplicação instalada podem ter armazenamento/sessões separados; confirme a conta no ícone que vai utilizar durante o trabalho.

Os passos correspondem às [instruções da Apple para adicionar uma aplicação web](https://support.apple.com/guide/iphone/iphea86e5236/ios). A posição dos controlos pode variar com a versão do iOS.

## Trabalho diário do motorista

1. **Serviços:** consulte cliente, referência, recolha, entrega, datas/horas, viatura, carga e instruções. Use pesquisa e filtro de estado.
2. **Abrir no mapa:** abre o endereço no Google Maps por iniciativa do utilizador. A aplicação não recolhe localização contínua nem inicia navegação automaticamente.
3. **Iniciar transporte:** confirme o serviço. O registo fica na fila de envio; o serviço só muda para **Em curso** depois da confirmação do servidor.
4. **Registar entrega:** introduza o nome do destinatário e a referência do comprovativo original. Ambos são obrigatórios. Pode juntar uma fotografia e uma assinatura desenhada no ecrã.
5. Fotografias são preparadas no dispositivo, reduzidas e convertidas para JPEG. Cada anexo enviado tem limite de **3 MB**. A assinatura é guardada como imagem PNG e não representa uma assinatura digital certificada.
6. Os anexos do comprovativo são enviados primeiro. A entrega só é enviada com os identificadores desses anexos depois de o servidor confirmar a respetiva receção. O registo conserva a data/hora capturada no dispositivo; confirme que o relógio do telemóvel está correto.
7. O botão **!** regista uma ocorrência: atraso, avaria, acidente, danos ou outro, com gravidade e descrição. Pode juntar fotografia. O botão **＋** anexa um documento de serviço (imagem ou PDF).
8. **Envios:** confirme o resultado de cada registo. **Enviado** só aparece quando o servidor confirmar o identificador exato da operação. A atualização dos serviços mostra o estado corrente confirmado pela TSS.

Uma ocorrência guardada sem ligação ainda não avisa operações. Use os canais habituais de contacto quando precisar de apoio imediato. Esta aplicação não faz chamadas de emergência nem envia notificações push.

## Funcionamento sem ligação e conflitos

O navegador guarda apenas os ficheiros públicos necessários para abrir a área móvel. Pedidos API, páginas de autenticação, respostas privadas e anexos do servidor não entram nessa cache de ficheiros. Os dados operacionais mínimos e os registos pendentes são guardados separadamente em IndexedDB, por identificador de conta; a palavra-passe e o token CSRF não são guardados nesse armazenamento.

Quando a aplicação não consegue contactar o servidor, pode abrir os últimos registos guardados através de **Abrir os meus registos guardados**. A área identifica o modo sem ligação e que a identidade precisa de confirmação antes do envio. O dispositivo deve estar protegido, porque os dados de trabalho locais não são cifrados pela aplicação e podem continuar acessíveis a quem desbloquear o navegador/dispositivo.

O início de um serviço pendente não transforma o cartão em **Em curso**. Primeiro envie e confirme o início; depois fica disponível a entrega. Isto evita inventar versões ou avançar estados do servidor enquanto está sem ligação.

Quando a rede volta, abra **Envios → Confirmar conta e enviar**. A aplicação confirma a sessão e exige a mesma conta que guardou os registos. Envia uma operação de cada vez e conserva os identificadores para repetir um pedido cuja resposta tenha sido perdida, sem duplicar o efeito confirmado no servidor. Os registos não são enviados silenciosamente por um utilizador diferente.

| Estado apresentado | Significado e ação |
| --- | --- |
| Pendente | Guardado neste dispositivo; enviar quando houver ligação |
| A enviar | Pedido em curso; aguardar confirmação |
| Enviado | Servidor confirmou esta operação |
| Entrar novamente | Sessão/acesso precisa de confirmação; entrar com a conta original |
| Rever conflito | Serviço mudou ou a ação foi recusada por um controlo; atualizar e rever explicitamente |
| Corrigir registo | O servidor recusou dados; conservar o registo e pedir apoio a operações |
| Revisto | Conflito anterior conservado; um pedido novo foi criado após revisão manual |

Em **Atualizar e rever**, a aplicação lê o serviço atual e mostra novamente os dados para uma confirmação humana. Só cria um novo pedido se o estado atual permitir a ação. Não atualiza automaticamente a versão de um pedido antigo. Se a entrega já estiver confirmada, o serviço deixar de estar atribuído ou houver outro bloqueio, operações deve resolver a situação; o registo pendente não é apagado.

O armazenamento pendente é limitado a 40 operações e cerca de 20 MB de dados preparados. Um formulário com fotografia/assinatura/entrega é guardado numa única transação local: se não houver espaço, não é apresentado como guardado. Conserve sempre os comprovativos originais.

## Sair e proteger o dispositivo

Em **Conta → Apagar dados locais e sair**, a aplicação mostra quantos registos ainda não têm confirmação. Pode voltar para os enviar ou escolher apagar e sair. A escolha de apagar elimina o armazenamento local dessa conta; não elimina os registos já guardados no servidor.

Se sair sem ligação, os dados locais são apagados e fica registada a intenção de terminar a sessão. No próximo arranque com rede, a aplicação termina a sessão antiga antes de apresentar dados de trabalho novamente. Não partilhe o dispositivo enquanto a sessão remota ainda não tiver sido terminada. Um dispositivo perdido exige desativar a conta/alterar o acesso na TSS e tratar o acesso físico ao dispositivo pelos procedimentos da empresa.

## Integração com a gestão de operações

As entregas móveis passam pelos mesmos controlos de versão, função e afetação do TMS. A ocorrência fica disponível para acompanhamento operacional. Fotografias, assinaturas e documentos são guardados como anexos privados; consultar um anexo exige sessão e autorização para o serviço.

Os automatismos existentes mantêm-se: uma entrega confirmada com preço válido pode preparar um rascunho interno; aprovar e emitir esse documento continua a exigir a decisão autorizada definida na aplicação. O motorista não recebe preços, saldos, faturas ou poderes de aprovação através desta área.

Os registos financeiros continuam internos. Esta versão não acrescenta faturação fiscal certificada, GPS contínuo, otimização automática de rotas, distribuição por lojas de aplicações ou um serviço alojado permanentemente.

## Verificação e ensaio antes de utilização operacional

Execute `npm test` ou `node --test tests/*.test.mjs`. Os testes do modelo móvel verificam privacidade, validação de comprovativos, limites de anexos, enumerações de ocorrências, repetição de operações, identidade, dependências de uploads, respostas perdidas, confirmação explícita e revisão manual de conflitos. Os testes de servidor verificam os controlos de acesso e a persistência das confirmações.

Para um ensaio isolado no navegador, `node tools/mobile-preview.mjs` cria dados fictícios numa pasta temporária e escuta em `http://127.0.0.1:4320/motorista`. Não lê o ficheiro operacional. As credenciais de teste são apresentadas apenas por esse iniciador e não constituem contas reais da TSS.

Antes de colocar motoristas a trabalhar, valide num Android e num iPhone reais: instalação com certificado confiável, login, serviços atribuídos, captura da câmara, assinatura, falta/retorno de ligação, envio, logout e recuperação de conflitos. O ensaio num navegador de computador não confirma automaticamente o comportamento da câmara, da instalação ou do armazenamento em cada telefone.

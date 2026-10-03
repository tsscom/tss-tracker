# TSS Gestão — piloto local v3.0
CRM, transportes (TMS), parque (YMS), oficina e controlo de recebimentos, em português de Portugal e euros. Esta versão permite validar os fluxos com Sergiu Sandu antes de uma implementação partilhada de produção.

## Iniciar e entrar
1. Faça duplo clique em **Iniciar-TSS.cmd** e mantenha a janela aberta.
2. Abra **http://127.0.0.1:4317**. No primeiro acesso, crie a conta de **Sergiu Sandu** e escolha uma palavra-passe de 12–128 caracteres. Não existe palavra-passe predefinida.
3. Nos acessos seguintes, entre com o utilizador e a palavra-passe escolhidos. Use **Palavra-passe** para a alterar e **Sair** para terminar a sessão.
4. A sessão termina após 30 minutos sem atividade, após 8 horas ou quando a aplicação reinicia. Os registos permanecem guardados.
5. Para terminar a aplicação, prima **Ctrl+C** na janela de execução. Depois pode voltar a iniciá-la.

O iniciador usa o Node.js incluído no Codex neste computador, ou Node.js 20+ disponível no PATH. O modo JSON não precisa de pacotes npm; o modo PostgreSQL usa o pacote `pg`. A aplicação escuta apenas em 127.0.0.1 por predefinição. O teste em telemóveis pode ser configurado explicitamente com HTTPS, como descrito abaixo.

## Novidades da v3
- **Painel:** aprovações pendentes, seguimentos comerciais, incidências, afetações em falta, comprovativos em falta, documentos caducados e manutenção prevista. Os valores financeiros aparecem apenas nas funções autorizadas.
- **Planeamento:** agenda diária com horas de recolha/entrega, mercadoria, peso, paletes e instruções. Serviços com horas usam janelas de tempo; dois serviços podem usar a mesma viatura/motorista quando o primeiro termina exatamente à hora em que o segundo começa. Serviços antigos sem horas continuam a ocupar dias completos.
- **Frota:** matrícula, marca/modelo, disponibilidade, capacidade, quilometragem, inspeção, seguro e próxima manutenção por data/km. Indisponibilidade, documentos caducados durante o serviço e excesso de capacidade bloqueiam expedição/início. A manutenção prevista gera alertas; continua a caber à oficina/gerente abrir, autorizar e libertar a intervenção.
- **Motoristas:** perfil, telefone, carta, validade, disponibilidade e associação a uma conta individual. Crie primeiro a conta com função Motorista em Utilizadores; depois associe o perfil e planeie o serviço. Um nome sem conta conserva a compatibilidade com serviços antigos, mas não dá acesso ao telemóvel.
- **CRM comercial:** oportunidades, fases, valor previsto, responsável, próximo contacto e atividades. Encerrar uma oportunidade exige motivo e bloqueia alterações. Ganho não cria sozinho um transporte; a proposta mantém a aprovação e aceitação pelo cliente.
- **Custos:** combustível, portagens, subcontratação, oficina e outros, por serviço, com fornecedor/referência/data. A contribuição é preço do serviço menos custos diretos registados; não representa lucro líquido, nem inclui automaticamente impostos ou custos gerais. Um cancelado tem receita prevista zero e conserva os custos efetivos já registados; não existe taxa de cancelamento implementada. Correções exigem a versão atual e ficam auditadas.
- **Incidências:** atraso, avaria, acidente, danos e outros; gravidade e resolução documentada. O motorista comunica apenas nos seus serviços; operações/gerente resolve.
- **Dossier e comprovativos:** JPG, PNG, PDF e assinatura, até 3 MB por ficheiro. Os ficheiros ficam fora da pasta pública e são verificados por tamanho/hash quando consultados. Cada consulta exige sessão, permissões e, para motoristas, atribuição ao serviço.
- **Motorista:** aplicação web instalável para Android/iPhone, acessível em **/motorista**. Inclui serviços atribuídos, início autorizado, comprovativo, fotografia, assinatura, incidências e fila de envios locais.

## Usar a aplicação do motorista
1. O gerente cria a conta individual e associa-a ao perfil em Motoristas.
2. Operações atribui o serviço, a viatura, as horas/carga e escolhe **Expedir**. A aplicação do motorista não pode autorizar a expedição.
3. O motorista abre **/motorista**, inicia sessão e consulta os seus serviços. Escolhe **Iniciar**, depois regista destinatário/referência e, quando necessário, foto/assinatura na entrega.
4. Sem ligação, os dados ficam **Por enviar** neste dispositivo. É necessário voltar a ligar, iniciar sessão na mesma conta e sincronizar. O transporte/documento financeiro no servidor só muda depois de aceitação. Um envio repetido conserva o mesmo identificador e não duplica a entrega ou o documento interno.
5. **Conflito** significa que a versão/atribuição/estado mudou. Reveja a informação com operações; a aplicação não força versões novas automaticamente. Iniciar e entregar ambos sem sincronizar o início pode exigir esta revisão.

Só a estrutura pública da aplicação é guardada pelo service worker; respostas da API e ficheiros privados não são guardados nessa cache. Os serviços mínimos, rascunhos e envios ficam separados por utilizador no armazenamento local do navegador. Não se guardam palavras-passe nem cookies nesse armazenamento. Use dispositivos e contas individuais; consulte o guia **[05_Mobile_e_operacoes.md](documentacao/05_Mobile_e_operacoes.md)** para os procedimentos de sessão, offline e instalação.

O computador permite validar a interface em **http://127.0.0.1:4317/motorista**. Esse endereço num telefone refere-se ao próprio telefone: para testar dois dispositivos, configure a rede local com HTTPS. Os telemóveis têm de estar na mesma rede Wi-Fi e o computador/servidor tem de permanecer ligado. O piloto não oferece acesso fora dessa rede, localização contínua, notificações push nem aplicações publicadas nas lojas.

## Teste explícito de telemóveis na rede local
Conserve o acesso local predefinido até preparar este teste. Não existem mudanças automáticas de firewall, certificados confiáveis ou exposição de rede.

1. Identifique o IP privado do computador na rede Wi-Fi (exemplo **192.168.1.50**; substitua pelo real).
2. Crie certificados com Python e o pacote `cryptography`: `python tools/criar-certificado-local.py --ip 192.168.1.50`. Neste computador, o Python incluído no Codex também está em `C:\Users\sandu\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe`. O comando cria `data/tls` e recusa substituir certificados existentes.
3. Instale **apenas data/tls/tss-local-ca.cer** como autoridade confiável nos dispositivos de teste. No iPhone, confirme também confiança SSL nas definições de certificados, seguindo o [guia da Apple](https://support.apple.com/en-us/102390); no Android, consulte as [instruções de certificados da Google](https://support.google.com/pixelphone/answer/2844832). As chaves `.pem` ficam privadas no computador. Se o navegador continuar a apresentar erro de certificado, corrija a confiança/IP antes de usar a aplicação.
4. Acrescente a `.env` (usando o IP real):

```dotenv
HOST=0.0.0.0
PORT=4317
ALLOWED_HOSTS=192.168.1.50:4317
TLS_KEY_FILE=data/tls/server-key.pem
TLS_CERT_FILE=data/tls/server-cert.pem
```

5. Termine a instância anterior e execute `node server.mjs`. Use o endereço HTTPS mostrado. Se a firewall do Windows impedir a ligação, configure uma regra limitada à rede privada/porta do teste. Esta aplicação não altera a firewall.
6. Abra **https://192.168.1.50:4317/motorista** no Android/Chrome ou iPhone/Safari, inicie sessão e use **Instalar**/**Adicionar ao ecrã principal**, se disponível. A confiança do certificado e os testes reais de câmara/instalação continuam a depender do dispositivo.

Para regressar à validação só no computador, remova HOST/ALLOWED_HOSTS/TLS_KEY_FILE/TLS_CERT_FILE da configuração e reinicie. Nunca execute duas instâncias sobre o mesmo JSON. A versão v3 foi testada no navegador do computador e em HTTPS com certificados de teste; não substitui testes físicos nos dois tipos de telefone.

## PostgreSQL
Esta versão acrescenta armazenamento PostgreSQL, mantendo a interface, contas, permissões e fluxos. A mudança só acontece quando `STORAGE_BACKEND=postgresql` (ou `postgres`) é definido no ambiente ou em `.env`. O modo predefinido continua a ser JSON. Uma falha do PostgreSQL interrompe a operação; não há regresso automático ao JSON.

Siga **[04_PostgreSQL.md](documentacao/04_PostgreSQL.md)** para instalar o servidor, criar `tss_gestao` e a conta técnica `tss_app`, configurar `.env`, importar e iniciar. No terminal do VS Code, dentro desta pasta:

```powershell
.\Instalar-dependencias.cmd
node tools/postgres-migrate.mjs --dry-run
```

A simulação valida e conta os dados sem os alterar nem ligar à base de dados. Depois de preparar a ligação, termine todas as instâncias da aplicação que usam o JSON e execute:

```powershell
node tools/postgres-migrate.mjs --apply
```

A importação cria primeiro uma cópia exata da origem e verifica integralmente os dados dentro da transação, antes de confirmar. Recusa bases já inicializadas; não existe opção para apagar ou substituir o destino. Após a verificação, configure `STORAGE_BACKEND=postgresql` em `.env` e inicie com `node server.mjs` ou `Iniciar-TSS.cmd`.

Há tabelas separadas para utilizadores, clientes, serviços, propostas, parque, oficina, documentos internos e auditoria. Os campos existentes permanecem em `jsonb` por registo, com colunas geradas, índices e relações protegidas no SQL. Apenas as linhas alteradas são gravadas, e cada operação confirma regras, estados e auditoria na mesma transação. Não se guarda o ficheiro inteiro numa única linha.

Esta é uma etapa de migração de armazenamento: a lógica ainda lê o conjunto de dados e as alterações usam um bloqueio transacional global. As sessões e os limites de tentativas também continuam na memória do processo. Consultas SQL por entidade, paginação e coordenação de sessões ficam para a fase de escala. O guia descreve estes limites e as cópias PostgreSQL. Depois da mudança, o JSON conserva apenas a fotografia antiga e não recebe as alterações feitas no PostgreSQL.

## Primeiro processo completo
1. **CRM · Clientes:** crie ou edite um cliente e atribua um responsável comercial, se existir. Para mudar um limite de crédito, faça um pedido e obtenha aprovação do gerente.
2. **Nova proposta:** indique cliente, locais, datas e preço. Guarde o rascunho, peça aprovação e valide em **Aprovações** ou no cartão da proposta.
3. **Registar aceitação:** introduza a referência do email ou encomenda aceite pelo cliente. Com a regra ativa, a aplicação converte automaticamente a proposta e cria um único serviço agendado. Escolha **Consultar serviço** para o planear. Com a regra desativada, escolha **Criar serviço**.
4. **TMS · Transportes:** use **Planear** para atribuir motorista e matrícula. Para uma conta de motorista consultar o serviço, selecione essa conta no planeamento.
5. **YMS · Parque:** quando aplicável, registe entrada, posição, movimentos e saída. A viatura deve sair do parque antes da expedição.
6. **Expedir** verifica afetação, conflitos por datas, presença no parque e bloqueios de oficina. Depois escolha **Iniciar transporte**.
7. **Registar entrega:** indique destinatário e referência do comprovativo e anexe a evidência no dossier/aplicação do motorista. Com a regra ativa, a aplicação prepara um único rascunho de documento interno. Conserve também os originais conforme o procedimento da empresa.
8. **Financeiro:** confira o rascunho e use **Editar prazo** para confirmar as condições acordadas com o cliente. Peça aprovação. Com a regra ativa, **Aprovar e emitir** regista a decisão explícita do gerente e emite o documento interno. Com as regras desativadas, crie o documento e/ou emita o registo aprovado manualmente.
9. **Registar recebimento:** indique montante, data e referência bancária. O saldo e o estado de pagamento mudam automaticamente: um recebimento parcial mantém um saldo; o pagamento integral marca o documento como Paga e o serviço como Pago. Montantes superiores ao saldo são recusados.

Os documentos financeiros desta aplicação são **registos internos e não faturas fiscais**. Não incluem cálculo fiscal nem integração com faturação certificada. A documentação descreve essa integração como trabalho futuro.

## Automatismos e transições
O gerente configura as regras no módulo **Automatismos → Configurar regras**. O auditor pode consultar as regras e o histórico; não pode alterar a configuração. Existem três regras inicialmente ativas:

| Evento confirmado | Resultado automático | Controlo mantido |
| --- | --- | --- |
| Aceitação do cliente numa proposta aprovada | Proposta Convertida e um novo serviço Agendado | Referência de aceitação obrigatória; operações atribui motorista/viatura e autoriza a saída |
| Entrega com comprovativo, ou primeiro comprovativo num serviço antigo concluído | Um rascunho de registo interno | Serviço concluído, POD e preço positivo; financeiro confere e pede aprovação |
| Aprovação explícita do gerente ao documento interno | Registo Emitida | Aprovação válida, serviço/POD/preço conferidos e eventual exceção do gerente justificada |

O prazo inicial do rascunho é **30 dias de calendário após a data local do comprovativo em Lisboa**. O gerente pode configurar 1–365 dias para os próximos documentos; o financeiro pode corrigir o vencimento de um rascunho individual. Este prazo de preparação deve ser confirmado com as condições do cliente.

Cada alteração das regras exige uma justificação e a versão atual da configuração. As alterações aplicam-se **aos próximos eventos**: não percorrem serviços antigos nem criam documentos retroativos. Desativar uma regra conserva os registos que ela já criou. Uma aprovação financeira aberta antes de uma mudança das regras exige atualização, para o gerente conhecer o efeito da sua decisão.

As transições e a operação que as desencadeou são guardadas na mesma transação. Pedidos concorrentes ou repetidos não criam serviços/documentos duplicados. A auditoria identifica regra, evento, estado anterior/seguinte, configuração e pessoa que desencadeou a transição. Um documento existente, mesmo rejeitado, impede criar outro automaticamente para o mesmo serviço.

A entrega de um serviço antigo com preço zero continua a ser registada; o rascunho automático fica por resolver, com motivo na auditoria. Não é inventado um montante. Créditos, cancelamentos, aprovação e libertação de oficina continuam a exigir decisão humana. O sistema não inicia transportes, saídas de parque ou reparações por tempo decorrido.

No TMS, **Pronto para expedir** é recalculado a partir da afetação, conflitos de datas, motorista ativo, presença no parque e bloqueios de oficina. **Expedir** fica indisponível quando há bloqueios; a validação é repetida no servidor.

## Oficina e aprovações
Em **Oficina**, crie uma ordem com matrícula, descrição e estimativa, peça aprovação, inicie o trabalho autorizado e conclua com custo real e notas de verificação. O gerente liberta a viatura. As ordens bloqueiam a expedição até serem rejeitadas ou libertadas.

Sem limites aprovados pela empresa, não há aprovação automática. O gerente decide propostas, alterações de crédito, documentos internos, cancelamentos e autorização/libertação de oficina. O limite de crédito aprovado é informativo neste piloto; o controlo automático de exposição pertence ao plano de produção.

Normalmente o autor não pode aprovar o próprio pedido. Para a validação individual de Sergiu, existe a opção **Aprovação pelo próprio gerente** com justificação de pelo menos 20 caracteres, gravada na auditoria. Registos alterados depois da consulta exigem atualização antes de guardar ou decidir.

## Utilizadores e responsabilidades
Em **Utilizadores**, Sergiu pode criar contas individuais, selecionar a função e ativar/desativar contas. Só Sergiu está identificado como pessoa real; as outras funções são modelos para atribuir a colaboradores.

- **Gerente / proprietário:** aprova decisões, gere exceções e contas.
- **Administrador de identidade e sistema:** gere contas e suporte; não aprova decisões financeiras nem atribui a função de gerente.
- **Comercial:** clientes, propostas e evidência da aceitação.
- **Operações:** planeamento, expedição, acompanhamento e comprovativos.
- **Motorista:** apenas os seus serviços atribuídos, sem preços ou pagamentos.
- **Parque:** entradas, localizações, movimentos e saídas.
- **Oficina:** necessidades, trabalhos autorizados e conclusão.
- **Financeiro:** documentos internos aprovados e recebimentos.
- **Auditor:** consulta de dados e histórico, sem alterações.

As permissões são verificadas no servidor. A última conta de gerente ativo é protegida. A mudança de função ou desativação invalida o acesso anterior. As palavras-passe são guardadas com scrypt e sal único; as sessões usam cookies HttpOnly/SameSite e as alterações exigem proteção CSRF. O piloto não inclui MFA, recuperação automática de palavra-passe nem proteção contra edição direta dos ficheiros por quem tem acesso ao computador.

## Pesquisa, filtros e CSV
Use a pesquisa nos módulos. No TMS pode combinar estado do serviço, pagamento, cliente e intervalo inclusivo de data de recolha. **Exportar CSV** exporta os serviços autorizados que correspondem aos filtros, em UTF-8, com ponto e vírgula, para Excel.

Os pagamentos são derivados dos recebimentos: Pendente, Parcial, Pago ou Em atraso. Um recebimento parcial conserva o estado Parcial mesmo depois do vencimento. O histórico de auditoria identifica autor, função, data e decisões.

## Dados existentes e cópias de segurança
Os dados persistem em **data/jobs.json**, incluindo contas, registos e auditoria. No primeiro arranque novo há oito serviços fictícios identificados como EXEMPLO; não foram criadas contas fictícias.

Ao atualizar a versão anterior, a aplicação cria uma cópia exata **jobs.json.v1-backup-….json** antes da migração. Conserva todos os serviços e o estado de pagamento anterior em **legacyPaymentStatus**. Não inventa comprovativos, documentos ou recebimentos para os serviços antigos: o estado corrente é calculado a partir dos registos internos, e o pagamento histórico é apresentado separadamente. Um serviço antigo concluído pode receber uma referência de comprovativo através de **Registar comprovativo**.

Ao atualizar um JSON v2 para v3, existe uma cópia exata **jobs.json.v2-backup-….json** antes de acrescentar as novas coleções. As contas e registos anteriores são conservados; a atualização não acrescenta frota, motoristas nem negócios fictícios aos dados existentes.

Para cópia ou restauro, termine a aplicação antes de copiar/substituir **data/jobs.json** e **data/attachments/** em conjunto. No modo PostgreSQL, copie a base e a mesma pasta privada de anexos. Os ficheiros de conteúdo são imutáveis; uma transação recusada pode deixar um ficheiro sem referência, que deve ser preservado até uma revisão de manutenção. Não apague anexos por comparação apressada com uma cópia antiga. Guarde a cópia com acesso controlado porque contém dados da empresa e credenciais derivadas. O CSV serve para consulta, não para restauro. Ficheiros inválidos são preservados e o arranque apresenta um erro.

## Documentação
Os mesmos ficheiros estão no módulo **Documentação** e na pasta **documentacao**:
- **01_Requisitos_e_governacao.pdf:** 39 requisitos, responsabilidades, permissões e processo cliente–pagamento.
- **02_Procedimentos_operacionais.pdf:** 13 procedimentos operacionais, evidências e tratamento de exceções.
- **03_Backlog_e_plano_de_sprints.pdf:** 44 histórias, critérios de aceitação e 10 sprints sugeridos de duas semanas.

Os PDFs foram inspecionados visualmente. Os DOCX correspondentes são fontes editáveis; a paginação do Word não foi verificada neste computador porque o motor LibreOffice necessário ao verificador não está disponível. Os requisitos distinguem funções implementadas no piloto de capacidades previstas para produção. O plano de sprints é uma proposta, sem calendário ou compromisso de entrega.

Estes manuais descrevem a base do piloto v2. A secção **Automatismos e transições** deste guia e o módulo **Processo** são a referência atualizada para o funcionamento da v2.1.

## Verificação técnica
Os comandos separados para desenvolvimento local, staging com Docker/HTTPS e
produção com GitHub + Render estão em **[06_CICD.md](documentacao/06_CICD.md)**.
Use `pnpm dev`, `pnpm staging:check` e `pnpm production:deploy`, respetivamente,
depois da configuração inicial descrita nesse guia. Os ambientes novos usam
armazenamento separado dos dados do piloto.

```powershell
node --test tests/*.test.mjs
node server.mjs
```
Os testes usam dados temporários separados e verificam autenticação, autorização, aprovação, migração, persistência, fluxo comercial até ao pagamento, parque/oficina, bloqueios, CSV, novas operações, comprovativos privados, HTTPS, envios repetidos e fila offline. Os testes de PostgreSQL real só são ativados com TSS_TEST_DATABASE_URL e usam esquemas temporários isolados.

A atualização v3 deste computador conserva o PostgreSQL já configurado. Antes da atualização foi guardada uma fotografia privada dos registos em **data/postgres-before-v3-….json**; a verificação confirmou que todas as contas, credenciais, registos e auditoria anteriores permaneceram iguais. Esta fotografia de registos é adicional às cópias regulares PostgreSQL; não substitui pg_dump, anexos nem configuração de restauro.

Verificação em 02/10/2026: a suite local tem 67 testes, com 63 aprovados e 4 testes de PostgreSQL real inicialmente ignorados. Esses 4 testes também foram depois executados e aprovados, em esquemas temporários isolados do PostgreSQL configurado: importação, rollback e concorrência de duas ligações independentes. O ensaio do navegador usou apenas dados fictícios separados: veículo, planeamento, início autorizado, foto comprimida, assinatura, entrega e incidente sem ligação, nova sessão e sincronização. A confirmação da entrega offline só criou o segundo rascunho interno quando o servidor voltou a aceitar o envio. A instalação/câmara em Android/iPhone físicos exige o ensaio HTTPS descrito neste guia.

Para uma porta diferente, defina $env:PORT = '4318' antes de executar node server.mjs.

# Orientacoes para agentes - MQTT Web

## Escopo

Aplicacao para acompanhar mensagens MQTT em tempo real, em uma arvore de
topicos. Backend e frontend rodam no mesmo container, sem banco de dados ou
servico auxiliar obrigatorio alem do broker monitorado.

Este arquivo e uma referencia explicita do projeto. O nome solicitado e
`AGENT.md`; nao presumir descoberta automatica por ferramentas que procuram
`AGENTS.md`. Para o fluxo de manutencao, consultar [SKILL.md](SKILL.md).

## Mapa do projeto

- `src/server.js`: Express, cliente MQTT, estado em memoria e WebSocket `/ws`.
- `public/app.js`: arvore, filtro, paginas de mensagens, atualizacao e tema.
- `public/index.html`: estrutura da interface e templates de linhas.
- `public/styles.css`: layout responsivo, temas e animacao de mensagens.
- `img/`: logo, favicon e imagens do projeto; servida em `/img`.
- `Dockerfile`: imagem Node que inclui `src`, `public` e `img`.
- `deploy/docker-compose.yml`: configuracao de deploy.
- `deploy/scripts/build-and-push-hub.sh`: build e publicacao no Docker Hub.
- `README.md`: uso e variaveis de ambiente.

## Convencoes

- Usar JavaScript ESM e os padroes existentes de Express, MQTT.js e `ws`.
- Manter a interface simples, em portugues, com assets locais.
- Preservar as alteracoes locais do usuario, inclusive movimentacoes de arquivos.
- Fazer commit apenas quando solicitado. Uma autorizacao de commit pontual nao
  autoriza commits futuros; confirmar o escopo de push ou publicacao no pedido.
- Nao versionar credenciais, `.env`, `node_modules` ou metadados do sistema.

## Comportamentos a preservar

- Topicos iniciam recolhidos, abrem por niveis e seguem ordem alfabetica natural.
- Novas mensagens nao devem reordenar os topicos.
- O destaque de chegada expira em 1 segundo, renovado por nova mensagem no caminho.
- Snapshot inicial contem resumos; mensagens sao buscadas sob demanda e paginadas.
- Atualizacoes visuais sao agrupadas; evitar reconstrucoes por pacote MQTT e
  renderizacao ilimitada de subtópicos em uma unica operacao.
- Tema inicial segue o sistema; escolha manual persiste em `mqtt-web-theme`.
- `POST /api/clear` limpa o estado da aplicacao para todos os clientes; nao apaga
  mensagens retidas no broker. A recepcao continua depois da limpeza.
- `/health` indica processo web vivo mesmo com broker desconectado.
- Assets atualmente usam `Cache-Control: no-store` para evitar versoes misturadas.

## Contratos e configuracao

`GET /api/state` retorna resumos, contadores, status MQTT e limites.
`GET /api/messages?topic=...&page=1&pageSize=100` retorna uma pagina do historico
em memoria. WebSocket publica `snapshot`, `status`, `message` e `cleared`.
Alterar produtores e consumidores em conjunto quando mudar esses contratos.

O filtro de assinatura usa `MQTT_ROOT_FILTER`, depois o alias `MQTT_TOPIC`,
depois `#`. O filtro da interface apenas restringe a visualizacao. Usuario e
senha vem de `MQTT_USERNAME` e `MQTT_PASSWORD` e nao devem aparecer na API ou logs.

O limite de armazenamento (`MAX_MESSAGES_PER_TOPIC`) e independente do tamanho
da pagina (`MESSAGES_PER_PAGE`). Ambos tem padrao 100 no servidor;
`TOPIC_CHILDREN_PER_PAGE` tem padrao 200. Consultar o codigo para outros limites
e o Compose para overrides especificos de deploy.

## Validacao e entrega

- Rodar `node --check src/server.js` e `node --check public/app.js` quando houver
  alteracao de codigo. Esses comandos verificam sintaxe, nao comportamento.
- Nao ha script `npm test` atualmente. Escolher verificacoes focadas na mudanca.
- Para interface, testar via HTTP, inclusive tema claro/escuro e viewport mobile.
  Abrir `file://` nao valida API nem WebSocket.
- Usar uma porta livre; nao encerrar processos alheios para liberar portas.
- Build local: `docker build -t mqtt-web .`, executado na raiz.
- Antes de usar o deploy movido, verificar caminhos: `build: .` no Compose aponta
  para `deploy/`, e o script calcula a raiz como o pai de `scripts/`. O Dockerfile
  permanece na raiz do repositorio. Resolver isso no escopo de trabalho de deploy.
- Relatar o que foi verificado e qualquer limitacao real. Build nao significa
  publicacao no Docker Hub, nem atualizacao de um container em execucao.

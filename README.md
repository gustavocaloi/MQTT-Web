# MQTT Web

Aplicacao web simples para acompanhar mensagens MQTT em tempo real, agrupadas por topico.

## Como funciona

O servidor Node conecta no broker MQTT, assina o filtro raiz configurado e envia as mensagens para a interface via WebSocket. A mesma aplicacao serve a UI e a API, entao o container nao depende de outro componente para subir alem do broker MQTT que voce quer monitorar.

Na interface, os topicos aparecem minimizados em arvore. Quando uma nova mensagem chega, o caminho do topico pulsa visualmente. Ao clicar em cada nivel, a arvore expande a separacao do topico; no ultimo nivel, as mensagens aparecem minimizadas e o payload abre com um novo clique.

As mensagens de cada topico sao paginadas. O tamanho da pagina e configurado por ambiente e no Compose o padrao esta em 100 mensagens por pagina. Para volumes grandes, os subtopicos tambem sao exibidos em lotes para manter a interface responsiva.

Importante: MQTT nao possui uma consulta universal de historico. A tela mostra mensagens retidas pelo broker e todas as novas mensagens recebidas apos a assinatura.

## Variaveis de ambiente

| Variavel | Padrao | Descricao |
| --- | --- | --- |
| `PORT` | `8080` | Porta HTTP da aplicacao |
| `MQTT_URL` | `mqtt://localhost:1883` | URL do broker MQTT |
| `MQTT_ROOT_FILTER` | `#` | Filtro raiz MQTT usado para assinar e limitar o que pode ser exibido |
| `MQTT_TOPIC` |  | Alias legado para `MQTT_ROOT_FILTER`, usado apenas se `MQTT_ROOT_FILTER` nao estiver definido |
| `MQTT_USERNAME` |  | Usuario MQTT, se necessario |
| `MQTT_PASSWORD` |  | Senha MQTT, se necessario |
| `MQTT_QOS` | `0` | QoS da assinatura |
| `MAX_MESSAGES_PER_TOPIC` | `100` | Quantidade maxima mantida em memoria por topico |
| `MESSAGES_PER_PAGE` | `100` | Quantidade de mensagens exibidas por pagina em cada topico |
| `TOPIC_CHILDREN_PER_PAGE` | `200` | Quantidade de subtopicos renderizados por lote em cada nivel da arvore |
| `MAX_PAYLOAD_PREVIEW` | `65536` | Limite de exibicao do payload por mensagem |

## Rodar localmente

```bash
npm install
MQTT_URL=mqtt://localhost:1883 npm start
```

Acesse `http://localhost:8080`.

## Rodar em container

```bash
docker build -t mqtt-web .
docker run --rm -p 8080:8080 \
  -e MQTT_URL=mqtt://host.docker.internal:1883 \
  -e MQTT_ROOT_FILTER='#' \
  -e MQTT_USERNAME='' \
  -e MQTT_PASSWORD='' \
  mqtt-web
```

Ou com Compose:

```bash
docker compose up --build
```

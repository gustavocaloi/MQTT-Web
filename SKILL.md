---
name: maintain-mqtt-web
description: Manter e diagnosticar o projeto MQTT Web, incluindo a ponte MQTT/WebSocket, arvore de topicos, filtros, paginacao, temas e deploy Docker. Usar em tarefas neste repositorio, respeitando seus contratos e limites de desempenho.
---

# Manutencao do MQTT Web

## Localizar o escopo

Ler [AGENT.md](AGENT.md) para arquitetura e preferencias do projeto. Inspecionar
`git status --short` e os arquivos envolvidos antes de editar. Consultar
`README.md` e `package.json` quando a tarefa envolver configuracao ou execucao.
Esta skill documenta o projeto; sua presenca na raiz nao equivale a instalacao
no catalogo de skills do agente.

## Diagnosticar pelo fluxo de dados

1. Conferir status MQTT, contadores e resumos em `/api/state`, evitando imprimir
   payloads inteiros ou credenciais. Diferenciar broker desconectado de assinatura
   sem mensagens e de falha de renderizacao.
2. Se os resumos chegam, verificar eventos de `/ws` e erros do navegador. Se a
   arvore abre mas mensagens nao aparecem, conferir a requisicao `/api/messages`,
   o caminho exato do topico e a pagina selecionada.
3. Para travamentos, observar frequencia de renderizacao, quantidade de nos DOM,
   timers e filas de eventos. Preservar resumos leves, carregamento sob demanda e
   agrupamento das atualizacoes. Validar cliques durante fluxo continuo.
4. Para versoes inconsistentes da UI, verificar os assets efetivamente servidos,
   cache e imagem do container em execucao antes de atribuir a causa ao MQTT.

## Alterar e verificar o comportamento relevante

- Filtros: separar filtro visual de assinatura raiz. Testar `flight/+/teste`,
  `flight/#`, topicos com maiusculas, niveis vazios e prefixo `$`. Nao assumir
  conformidade pelo nome das funcoes: o codigo atual converte filtros para
  minusculas e remove niveis vazios ao montar a arvore. Sao pontos de atencao
  quando a tarefa envolver fidelidade de nomes ou filtros MQTT.
- Paginacao: testar mais de uma pagina usando armazenamento maior que o tamanho
  da pagina. Conferir primeira/ultima pagina, novas mensagens durante uma busca,
  reconexao e respostas pendentes depois de limpar a tela.
- Atualizacao: verificar ordem alfabetica, expansao preservada e pulso de 1s
  encerrando sem precisar de clique. Snapshot ou alteracao de tema nao deve criar
  sinal falso de mensagem nova.
- Tema e layout: testar preferencia do sistema, escolha salva apos recarga,
  legibilidade de linhas/payloads e ausencia de sobreposicao em mobile.
- Limpeza: usar instancia de teste; a rota limpa a memoria de todos os clientes
  dessa instancia. Verificar que eventos anteriores nao reaparecem por cache.

Escolher apenas os cenarios relacionados ao pedido. Para testes MQTT, preferir
broker de teste e topicos isolados; nao publicar dados sinteticos ou limpar uma
instancia compartilhada de producao como parte de uma validacao rotineira.

## Executar localmente

Usar dependencias do lockfile (`npm ci` quando precisar instala-las). Iniciar
`npm start` com `PORT` livre e `MQTT_URL` do ambiente de teste. Acessar por HTTP.
Verificar sintaxe dos arquivos JS alterados e comportamento real correspondente;
nao apresentar uma checagem de sintaxe como teste visual ou de integracao.

## Preparar deploy quando solicitado

Conferir `Dockerfile`, `deploy/docker-compose.yml` e
`deploy/scripts/build-and-push-hub.sh`. Validar os caminhos relativos apos a
movimentacao para `deploy/`; o contexto da build precisa incluir o Dockerfile,
`src/`, `public/`, `img/` e manifests de dependencias da raiz.

Validar Compose e build antes de publicar. O script de publicacao faz push e a
opcao `--prune` remove caches/recursos locais; nao executa-lo como simples teste
de sintaxe. Confirmar imagem/tag de destino no contexto do pedido, pois os
exemplos do script ainda mencionam outro projeto. Publicar e fazer commit/push
somente dentro da autorizacao do usuario.

## Entregar

Descrever a mudanca e a verificacao realizada de forma breve. Indicar URL local
se houver servidor para demonstracao. Distinguir arquivos locais, commit, push,
imagem construida e imagem publicada conforme o que realmente foi executado.

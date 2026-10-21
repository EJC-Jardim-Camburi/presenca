# Chamada · Grupo Jovem Sagrada Família

Sistema de presença por QR Code do grupo de jovens da Matriz Sagrada Família (Jardim Camburi, Vitória/ES).

- **`index.html`**: página pública. Sem `?e=` mostra a entrada; com `?e=CODIGO` é o check-in do encontro: o jovem digita o WhatsApp, confirma (ou se cadastra na primeira vez) e vê o botão do grupo do WhatsApp.
- **`coordenacao.html`**: área da coordenação (login por e-mail e senha). Painel, encontros (abrir/fechar chamada, QR em tela cheia ao vivo, presença manual), pessoas (status Novo/Frequente/Ocasional/Sumido, WhatsApp, mesclar duplicados) e ajustes (local, raio, link do grupo, equipe).

Site estático, sem build: HTML + CSS + JavaScript puro. Bibliotecas em `vendor/` (supabase-js 2.118.0, qrcode-generator 1.4.4).

## Banco de dados

Supabase criado pelo Lovable Cloud (projeto Lovable `8fb41d25-ade5-4168-8840-da263ca4bf64`). **Não apague o projeto no Lovable**: o banco mora lá. O site só usa a chave pública; quem protege os dados são as regras (RLS):

- a página pública só chama `public_meeting`, `public_lookup` e `public_checkin`, que devolvem no máximo o primeiro nome;
- pessoas, encontros e presenças só são lidos por quem está na tabela `coordinators`;
- só e-mails pré-cadastrados em `coordinators` viram coordenadores ao criar a conta.

Esquema em `db/`. Os dados (nomes e telefones) **nunca** entram neste repositório, que é público.

## Rodar localmente

```bash
python3 -m http.server 5173
```

Abrir http://localhost:5173 (check-in: `http://localhost:5173/index.html?e=CODIGO`).

## Publicar

GitHub Pages, branch `main`, pasta raiz. Todo `git push` publica em 1–2 minutos.

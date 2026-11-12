export function invitePage(rawToken: string, webAppUrl = "") {
  const token = /^[A-Za-z0-9_-]{20,100}$/.test(rawToken) ? rawToken : "";
  const deepLink = `zelo://invite/${token}`;
  const webLink = /^https:\/\/[\w.-]+(:\d+)?$/.test(webAppUrl)
    ? `${webAppUrl}/invite/${token}`
    : "";

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Convite - Zelo</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f5f7fa;color:#1b2430;display:flex;justify-content:center}
  main{max-width:420px;width:100%;padding:32px 20px}
  h1{font-size:24px;margin:0 0 8px}
  p{line-height:1.5;color:#46515f}
  .btn{display:block;text-align:center;background:#2e7d6b;color:#fff;text-decoration:none;font-weight:600;padding:16px;border-radius:12px;margin:24px 0 12px;font-size:17px}
  .code{word-break:break-all;background:#fff;border:1px solid #d5dbe3;border-radius:10px;padding:12px;font-family:ui-monospace,monospace;font-size:13px}
  button{width:100%;margin-top:10px;padding:14px;border-radius:12px;border:1px solid #2e7d6b;background:#fff;color:#2e7d6b;font-weight:600;font-size:16px}
  small{display:block;margin-top:24px;color:#6b7686}
</style>
</head>
<body>
<main>
  <h1>Convite para cuidar de um paciente</h1>
  ${
    token
      ? `<p>Você foi convidado(a) para participar do cuidado de um paciente no Zelo.</p>
  <a class="btn" href="${deepLink}">Abrir no app Zelo</a>
  ${webLink ? `<a class="btn" style="background:#fff;color:#2e7d6b;border:1px solid #2e7d6b;margin-top:0" href="${webLink}">Abrir no navegador</a>` : ""}
  <p>Se o app não abrir, abra o Zelo, toque em <b>Tenho um convite</b> e cole este código:</p>
  <div class="code" id="code">${token}</div>
  <button id="copy" type="button">Copiar código</button>
  <small>O convite vale por 7 dias, só pode ser usado uma vez e exige entrar com o e-mail que foi convidado.</small>
  <script>
    document.getElementById("copy").addEventListener("click", function () {
      var text = document.getElementById("code").textContent;
      var done = function () { document.getElementById("copy").textContent = "Código copiado!"; };
      if (navigator.clipboard) { navigator.clipboard.writeText(text).then(done); } else { done(); }
    });
    var isAndroid = /Android/i.test(navigator.userAgent);
    var target = (${JSON.stringify(webLink)} && !isAndroid) ? ${JSON.stringify(webLink)} : ${JSON.stringify(deepLink)};
    setTimeout(function () { window.location.href = target; }, 400);
  </script>`
      : `<p>Este link de convite não é válido. Peça um novo ao cuidador responsável.</p>`
  }
</main>
</body>
</html>`;
}

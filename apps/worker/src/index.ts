import { HSTS } from '@marklayer/brand';
import type { Context } from 'hono';
import { Hono } from 'hono/tiny';
import { RELAY_PREFIX } from '../shared/posthog-relay-path';
import { agentSurface } from './agent-surface';
import { api } from './api';
import { auth } from './auth';
import { scheduled } from './cron';
import type { Env } from './env';
import { slackRoutes } from './integrations/slack-routes';
import { ogRoutes } from './og-routes';
import { relayToPosthog } from './posthog-relay';
import { proxy } from './proxy';
import { rooms } from './rooms';
import { sharePages } from './share-pages';
import { shellResponse } from './shell';
import { uploadRoutes } from './upload-routes';

export { AnnotationRoom } from './annotation-room';

const app = new Hono<Env>();

// HSTS (Cloudflare Security Insights: "Domains without HSTS"). TLS terminates
// at the Cloudflare edge, so the worker never sees plaintext requests — the
// HTTP→HTTPS redirect belongs at the zone level ("Always Use HTTPS"), not here.
// 2-year max-age with includeSubDomains + preload meets the hstspreload.org
// submission threshold.
app.use('*', async (c, next) => {
  await next();
  // Skip 101 WebSocket upgrades — their headers are locked. Header objects from
  // upstream fetches (proxy, assets) can be immutable, so rebuild on failure.
  if (c.res.status !== 101) {
    try {
      c.res.headers.set('Strict-Transport-Security', HSTS);
    } catch {
      const headers = new Headers(c.res.headers);
      headers.set('Strict-Transport-Security', HSTS);
      c.res = new Response(c.res.body, { status: c.res.status, statusText: c.res.statusText, headers });
    }
  }
});

app.route('/api', api);

app.route('/', sharePages);

app.route('/', ogRoutes);

app.route('/', rooms);

app.route('/', uploadRoutes);

app.all(`${RELAY_PREFIX}/*`, (c) => relayToPosthog({ req: c.req.raw, host: c.env.POSTHOG_HOST, ctx: c.executionCtx }));

app.route('/', agentSurface);

app.route('/auth', auth);

app.route('/integrations/slack', slackRoutes);

// The dashboard is its own bundle (app.html), so `/app` resolves from the asset
// layer — but `/app/links` does not, and an unmatched path falls through to the
// proxy catch-all, which would try to fetch it as a remote URL. Serve the same
// shell for every path under /app and let the client router read the rest.
// `/app`, not `/app.html`: the asset layer redirects the extension away.
const appShell = (c: Context<Env>) => shellResponse({ env: c.env, url: c.req.url, path: '/app' });
app.get('/app', appShell);
app.get('/app/*', appShell);

// Minimal browser shell: keeps MarkLayer's existing reverse proxy, but omits
// the review board and all annotation/comment UI.
app.get('/browser', (c) => c.html(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MarkLayer Browser</title>
  <style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font:14px system-ui,sans-serif;background:#fff;color:#222}
    .bar{height:48px;display:flex;align-items:center;gap:7px;padding:6px 10px;border-bottom:1px solid #ddd;background:#f7f7f7}
    button{height:34px;min-width:34px;border:1px solid #ddd;border-radius:7px;background:#fff;color:#222;cursor:pointer;font-size:16px}
    button:disabled{opacity:.4;cursor:default}form{display:flex;flex:1;min-width:0;gap:7px}input{height:34px;min-width:0;flex:1;padding:0 12px;border:1px solid #ddd;border-radius:7px;font:14px system-ui,sans-serif;outline:none}input:focus{border-color:#888}
    #go{padding:0 14px;font-size:13px}#frame{display:block;width:100%;height:calc(100% - 48px);border:0;background:#fff}
    @media(max-width:520px){.bar{gap:4px;padding:5px}.bar button{min-width:30px}#go{padding:0 9px}}
  </style>
</head>
<body>
  <div class="bar">
    <button id="back" title="Back" disabled>←</button>
    <button id="forward" title="Forward" disabled>→</button>
    <button id="reload" title="Reload">↻</button>
    <form id="nav"><input id="address" type="text" placeholder="Enter a website address…" autocomplete="url" spellcheck="false"><button id="go" type="submit">Go</button></form>
  </div>
  <iframe id="frame" title="Website" allow="autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-read; clipboard-write" allowfullscreen></iframe>
  <script>
    (()=>{
      const frame=document.getElementById('frame'), address=document.getElementById('address');
      const back=document.getElementById('back'), forward=document.getElementById('forward');
      let history=[], index=-1, current='';
      function normalize(value){let v=value.trim();if(!v)return '';if(!/^https?:\/\//i.test(v))v='https://'+v;try{const u=new URL(v);if(!['http:','https:'].includes(u.protocol))return '';return u.href}catch{return ''}}
      function update(){back.disabled=index<=0;forward.disabled=index<0||index>=history.length-1;address.value=current}
      function navigate(value,push=true){const url=normalize(value);if(!url){address.focus();return}current=url;if(push){history=history.slice(0,index+1);history.push(url);index=history.length-1}frame.src='/proxy?url='+encodeURIComponent(url);update()}
      document.getElementById('nav').addEventListener('submit',e=>{e.preventDefault();navigate(address.value)});
      back.addEventListener('click',()=>{if(index>0){index--;current=history[index];frame.src='/proxy?url='+encodeURIComponent(current);update()}});
      forward.addEventListener('click',()=>{if(index<history.length-1){index++;current=history[index];frame.src='/proxy?url='+encodeURIComponent(current);update()}});
      document.getElementById('reload').addEventListener('click',()=>{if(current)frame.src='/proxy?url='+encodeURIComponent(current)});
      window.addEventListener('message',e=>{if(e.origin!==location.origin||!e.data||e.data.type!=='ml-navigate'||typeof e.data.url!=='string')return;navigate(e.data.url)});
      const initial=new URLSearchParams(location.search).get('url');
      navigate(initial||'https://www.youtube.com/');
    })();
  </script>
</body>
</html>`));

// Proxy + catch-all (must be last)
app.route('/', proxy);

export default { ...app, scheduled };

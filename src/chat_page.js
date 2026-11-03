// PizzaResolve customer chat page (Team CodeVerse). Hosts the Talkdesk chat widget for touchpoint
// PizzaResolve_Codeverse (8650d28e505547e199a5f16819de8bb8). The widget talks to Talkdesk directly;
// this server only serves static HTML. Synthetic demo only.
export function chatPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PizzaResolve Support</title>
<style>:root{--bg:#fff;--fg:#1d1b20;--muted:#5f5b66;--accent:#5b1fd6}@media (prefers-color-scheme:dark){:root{--bg:#141218;--fg:#ece6f0;--muted:#b5adbd;--accent:#b79cff}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}main{max-width:560px;margin:48px auto;padding:0 16px}
h1{font-size:24px;margin:0 0 8px}p,li{color:var(--muted)}code{color:var(--fg)}</style></head><body><main>
<h1>PizzaResolve support</h1>
<p>Open the chat bubble in the corner and describe the problem with your order. The assistant will verify you first (order reference, last 4 digits of your phone, postcode), then fix what it can.</p>
<p>Demo test data (synthetic): order <code>ORD-7099</code>, phone last 4 <code>7777</code>, postcode <code>560099</code>.</p>
<p><small>Team CodeVerse hackathon demo. Synthetic accounts only; no real customer data.</small></p>
</main>
<!-- Start of Talkdesk Code -->
<script>
  var webchat;
  (function(window, document, node, props, configs) {
    if (window.TalkdeskChatSDK) { console.error("TalkdeskChatSDK already included"); return; }
    var divContainer = document.createElement("div");
    divContainer.id = node;
    document.body.appendChild(divContainer);
    var src = "https://talkdeskchatsdk.talkdeskapp.com/v2/talkdeskchatsdk.js";
    var script = document.createElement("script");
    var firstScriptTag = document.getElementsByTagName("script")[0];
    script.type = "text/javascript";
    script.charset = "UTF-8";
    script.id = "tdwebchatscript";
    script.src = src;
    script.async = true;
    firstScriptTag.parentNode.insertBefore(script, firstScriptTag);
    script.onload = function() {
      webchat = TalkdeskChatSDK(node, props);
      webchat.init(configs);
    };
  })(
    window,
    document,
    "tdWebchat",
    { touchpointId: "8650d28e505547e199a5f16819de8bb8", accountId: "", region: "td-us-1" },
    { enableValidation: false, enableEmoji: true, enableUserInput: true, enableAttachments: false }
  );
</script>
<!-- End of Talkdesk Code -->
</body></html>`;
}

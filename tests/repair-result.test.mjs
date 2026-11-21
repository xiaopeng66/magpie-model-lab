import test from "node:test";
import assert from "node:assert/strict";
import { extractHTML, classifyResult, previewDocument } from "../lib/result.mjs";

test("A100-001: apparent roots in comments, templates and quoted attributes are ignored", () => {
  const document = '<!doctype html><html data-note="> </html>"><head></head><body><canvas id="real"></canvas></body></html>';
  for (const prefix of ['<!-- <html>fake</html> -->', '<template><html>fake</html></template>', '<div title="<html>fake</html>"></div>']) {
    assert.equal(extractHTML(prefix + document), document);
  }
});

test("A100-001: raw-text closing lookalikes never truncate the actual HTML document", () => {
  for (const tag of ["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]) {
    const html = `<html><head></head><body><${tag} data-value=">">literal </html></${tag}><canvas></canvas><script>animate()</script></body></html>`;
    assert.equal(extractHTML(html), html, tag);
    assert.equal(classifyResult(html, "stop").html, html, tag);
    assert.ok(previewDocument({ id: "fixture", html }).includes('<canvas></canvas>'));
  }
});

test("A100-001: plaintext and unterminated raw text cannot supply a complete root closing tag", () => {
  for (const body of ['<plaintext>literal </html>', '<xmp>literal </html>', '<!-- literal </html>']) {
    const reply = '<html><body>' + body;
    assert.equal(extractHTML(reply), "");
    assert.equal(classifyResult(reply, "stop").status, "invalid");
  }
  const html = '<html><template><div></html></div></template><body>real</body></html>';
  assert.equal(extractHTML('```html\n' + html + '\n```'), html);
});

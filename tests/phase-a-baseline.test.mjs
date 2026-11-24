import test from "node:test";
import assert from "node:assert/strict";
import { phaseABoot } from "./phase-a-fixtures.mjs";
import { uiHarness } from "./ui-harness.mjs";
import { waitFor } from "./helpers.mjs";

test("all five existing views retain navigation and manual timeout behavior", async () => {
  const boot = phaseABoot();
  const ui = await uiHarness({ bootstrap: boot, detail: id => boot.runs.find(run => run.id === id) });
  await waitFor(() => ui.elements.get("version").textContent === boot.version);
  for (const name of ["current", "fingerprint", "candy", "favorites", "history"]) {
    await ui.elements.get(`${name}-tab`).fire("click");
    assert.equal(ui.elements.get(`${name}-tab`).getAttribute("aria-selected"), "true");
    assert.equal(ui.elements.get(`${name}-panel`).hidden, false);
    assert.equal(ui.elements.get("generate").disabled, ["favorites", "history"].includes(name));
  }
  assert.equal(ui.elements.get("generation-timeout").value, "600");
  assert.equal(ui.elements.get("max-tokens").value, "64000");
});

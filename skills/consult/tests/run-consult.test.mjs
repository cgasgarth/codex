import { describe, expect, it } from "bun:test";
import {
  attachGitHubPlugin,
  ensureChatMode,
  enableImageMode,
  ensureThinkingLevel,
  sendToExistingConsult,
  startConsult,
  verifyAnswerModel,
  verifyThinkingLevel,
} from "../scripts/run-consult.mjs";

function modeTab({ checked = false, authenticationRequired = false, missing = false } = {}) {
  let chatChecked = checked;
  let clicks = 0;
  let snapshots = 0;

  const chat = {
    async click() {
      clicks += 1;
      chatChecked = true;
    },
    async count() {
      return 1;
    },
    async getAttribute(name) {
      return name === "aria-pressed" && chatChecked ? "true" : "false";
    },
    async isVisible() {
      return true;
    },
  };
  const surface = {
    async count() {
      return missing ? 0 : 1;
    },
    getByRole(role, options) {
      expect(role).toBe("button");
      expect(options).toEqual({ name: "Chat", exact: true });
      return chat;
    },
    async waitFor() {
      if (missing) throw new Error("missing");
    },
  };
  const tab = {
    playwright: {
      async domSnapshot() {
        snapshots += 1;
        return authenticationRequired ? "Log in" : "ChatGPT";
      },
      getByRole(role, options) {
        expect(role).toBe("group");
        expect(options).toEqual({ name: "Composer mode", exact: true });
        return surface;
      },
    },
  };
  return {
    tab,
    state: () => ({ chatChecked, clicks, snapshots }),
  };
}

describe("ensureChatMode", () => {
  it("leaves an already-selected Chat surface unchanged", async () => {
    const fixture = modeTab({ checked: true });

    expect(await ensureChatMode(fixture.tab)).toEqual({
      status: "chat_selected",
      chatSurface: "chat",
    });
    expect(fixture.state()).toEqual({ chatChecked: true, clicks: 0, snapshots: 1 });
  });

  it("switches from Work to Chat and verifies the result", async () => {
    const fixture = modeTab();

    expect(await ensureChatMode(fixture.tab)).toEqual({
      status: "chat_selected",
      chatSurface: "chat",
    });
    expect(fixture.state()).toEqual({ chatChecked: true, clicks: 1, snapshots: 2 });
  });

  it("preserves the authentication handoff when the selector is unavailable", async () => {
    const fixture = modeTab({ authenticationRequired: true, missing: true });

    expect(await ensureChatMode(fixture.tab)).toEqual({ status: "authentication_required" });
    expect(fixture.state().clicks).toBe(0);
  });

  it("fails closed when the selector is missing from an authenticated page", async () => {
    const fixture = modeTab({ missing: true });

    expect(ensureChatMode(fixture.tab)).rejects.toThrow("did not expose");
  });
});

describe("attachGitHubPlugin", () => {
  it("waits for the plugin list and attaches the GitHub button", async () => {
    let attached = false;
    let waited = false;
    const box = {
      async count() {
        return 1;
      },
      async textContent() {
        return "";
      },
      getByText(text, options) {
        expect(text).toBe("GitHub");
        expect(options).toEqual({ exact: true });
        return {
          async waitFor() {},
          async isVisible() {
            return attached;
          },
        };
      },
    };
    const add = {
      async count() {
        return 1;
      },
      async click() {},
    };
    const tab = {
      playwright: {
        async domSnapshot() {},
        getByRole(role, options) {
          if (role === "textbox") {
            expect(options).toEqual({ name: "New chat in Consult", exact: true });
            return box;
          }
          expect(role).toBe("button");
          if (options.name === "Add files and more") return add;
          expect(options.name.test("GitHub Triage PRs, issues, CI, and publish flows")).toBe(true);
          return {
            async waitFor() { waited = true; },
            async count() {
              return waited ? 1 : 0;
            },
            async click() { attached = true; },
          };
        },
      },
    };

    await attachGitHubPlugin(tab, "New chat in Consult");

    expect({ attached, waited }).toEqual({ attached: true, waited: true });
  });
});

describe("enableImageMode", () => {
  it("verifies the current image pill after the composer is replaced", async () => {
    let imageModeEnabled = false;
    let snapshots = 0;
    const add = {
      async count() {
        return 1;
      },
      async click() {},
    };
    const create = {
      async count() {
        return 1;
      },
      async click() {
        imageModeEnabled = true;
      },
    };
    const pill = {
      async count() {
        return imageModeEnabled ? 1 : 0;
      },
      async isVisible() {
        return imageModeEnabled;
      },
      async waitFor() {
        if (!imageModeEnabled) throw new Error("image mode not enabled");
      },
    };
    const missingRatioButton = {
      async count() {
        return 0;
      },
      async isVisible() {
        return false;
      },
    };
    const tab = {
      playwright: {
        async domSnapshot() {
          snapshots += 1;
        },
        getByRole(role, options) {
          expect(role).toBe("button");
          if (options.name === "Add files and more") return add;
          expect(options).toEqual({ name: "Choose image aspect ratio", exact: true });
          return missingRatioButton;
        },
        getByText(text, options) {
          expect(text).toBe("Create image");
          expect(options).toEqual({ exact: true });
          return create;
        },
        locator(selector) {
          expect(selector).toBe(
            '[data-inline-selection-pill][data-id="picture_v2"][data-keyword="Create image"]',
          );
          return pill;
        },
      },
    };

    expect(await enableImageMode(tab, "16:9")).toEqual({
      promptPrefix: "Create the image at a 16:9 aspect ratio.\n\n",
    });
    expect({ imageModeEnabled, snapshots }).toEqual({
      imageModeEnabled: true,
      snapshots: 2,
    });
  });
});

describe("startConsult", () => {
  it("rejects an invalid thinking level before opening a tab or preparing files", async () => {
    let opened = false;
    await expect(startConsult({
      iab: { tabs: { async new() { opened = true; } } },
      project: "Consult", prompt: "Test", thinkingLevel: "invalid",
      paths: ["relative-path"],
    })).rejects.toThrow("Unsupported thinkingLevel");
    expect(opened).toBe(false);
  });
  it("rejects incompatible GitHub and image modes before opening a tab", async () => {
    let openedTabs = 0;
    const iab = {
      tabs: {
        async new() {
          openedTabs += 1;
          return {};
        },
      },
    };

    expect(
      startConsult({
        iab,
        project: "Consult",
        prompt: "Create a visual.",
        createImage: true,
        attachGitHub: true,
      }),
    ).rejects.toThrow("cannot remain active with the GitHub plugin attached");
    expect(openedTabs).toBe(0);
  });
});

describe("ensureThinkingLevel", () => {
  function thinkingTab(initialLabel = "5.6 Pro", { stuckStatus = null } = {}) {
    let activeLabel = initialLabel;
    let menuOpen = false;
    let power = ["Instant", "Medium", "High", "Extra High"].indexOf(initialLabel);
    if (power < 0) power = 4;
    let powerChanges = 0;
    let latestSelected = initialLabel === "6 Pro";
    const control = {
      async click() { menuOpen = !menuOpen; },
      async count() { return 1; },
    };
    const slider = {
      async count() { return menuOpen ? 1 : 0; },
      async getAttribute(name) {
        expect(name).toBe("aria-valuenow");
        return String(power);
      },
      async press(key) {
        expect(menuOpen).toBe(true);
        powerChanges += 1;
        if (key === "Home") power = 0;
        if (key === "ArrowRight") power += 1;
        activeLabel = ["Instant", "Medium", "High", "Extra High", "6 Pro"][power];
      },
    };
    const statusLabels = ["Instant", "Medium", "High", "Extra High", "Pro"];
    const menu = {
      async count() { return menuOpen ? 1 : 0; },
      async isVisible() { return menuOpen; },
      async waitFor() { expect(menuOpen).toBe(true); },
      locator(selector) {
        if (selector === '[role="status"]') return {
          async count() { return menuOpen ? 1 : 0; },
          async innerText() { return `${stuckStatus ?? statusLabels[power]}, ${power + 1} of 5.`; },
        };
        expect(selector).toBe('[role="menuitemradio"][aria-checked="true"]');
        return {
          async count() { return menuOpen ? 1 : 0; },
          async innerText() { return latestSelected ? "GPT-6" : "GPT-5.6 Sol"; },
        };
      },
    };
    const latestRadio = {
      async count() { return menuOpen ? 1 : 0; },
      async getAttribute(name) {
        expect(name).toBe("aria-checked");
        return String(latestSelected);
      },
      async press(key) {
        expect(key).toBe("Space");
        latestSelected = true;
        activeLabel = "6 Pro";
      },
    };
    const tab = {
      playwright: {
        async domSnapshot() {},
        locator(selector) {
          if (selector === '[role="slider"]') return slider;
          expect(selector).toBe('[role="menuitemradio"]');
          return {
            filter(options) {
              expect(options.hasText.test("GPT-6")).toBe(true);
              expect(options.hasText.test("GPT-6.1")).toBe(false);
              return latestRadio;
            },
          };
        },
        getByRole(role, options) {
          expect(options).toEqual({ name: "Select ChatGPT model", exact: true });
          if (role === "menu") return menu;
          expect(role).toBe("button");
          return control;
        },
      },
    };
    return { tab, state: () => ({ activeLabel, latestSelected, menuOpen, modelMenuOpen: false, power, powerChanges }) };
  }

  for (const initial of ["Instant", "Medium", "High", "Extra High", "6 Pro"]) {
    for (const [level, label] of [["instant", "Instant"], ["medium", "Medium"], ["high", "High"], ["extra-high", "Extra High"], ["pro", "6 Pro"], [" Extra High ", "Extra High"]]) {
      it(`selects ${level} from ${initial}`, async () => {
        const fixture = thinkingTab(initial);
        const result = await ensureThinkingLevel(fixture.tab, level);
        expect(result.thinkingLevel).toBe(level.trim().toLowerCase().replace(" ", "-"));
        expect(fixture.state().activeLabel).toBe(label);
        expect(fixture.state().menuOpen).toBe(false);
      });
    }
  }

  it("returns the observed selector state, not a hard-coded label", async () => {
    const { tab } = thinkingTab("Medium");
    expect(await ensureThinkingLevel(tab, "medium")).toEqual({
      thinkingLevel: "medium", mode: "Medium", model: "GPT-5.6 Sol", power: 1,
    });
  });

  it("fails when ChatGPT does not announce the requested level", async () => {
    const { tab } = thinkingTab("6 Pro", { stuckStatus: "Medium" });
    await expect(ensureThinkingLevel(tab, "pro")).rejects.toThrow("GPT-6 Pro was not selected");
  });

  it("verifies the current level without changing it", async () => {
    const fixture = thinkingTab("6 Pro");
    expect(await verifyThinkingLevel(fixture.tab, "pro")).toEqual({
      thinkingLevel: "pro", mode: "Pro", model: "GPT-6", power: 4,
    });
    expect(fixture.state().powerChanges).toBe(0);
    expect(fixture.state().menuOpen).toBe(false);
    await expect(verifyThinkingLevel(thinkingTab("Medium").tab, "pro")).rejects.toThrow("Expected GPT-6 Pro");
  });

  it("changes an alternate Pro model to GPT-6 Pro", async () => {
    const {tab, state} = thinkingTab();
    expect(await ensureThinkingLevel(tab, "pro")).toEqual({
      thinkingLevel: "pro",
      mode: "Pro",
      model: "GPT-6",
      power: 4,
    });
    expect(state()).toEqual({
      activeLabel: "6 Pro",
      latestSelected: true,
      menuOpen: false,
      modelMenuOpen: false,
      power: 4,
      powerChanges: 0,
    });
  });
});

describe("sendToExistingConsult", () => {
  it("does not inspect or change the Chat/Work surface for a follow-up", async () => {
    let typedPrompt = "";
    const box = {
      async count() {
        return 1;
      },
      filter() {
        return this;
      },
      async innerText() {
        return "";
      },
      async type(value) {
        typedPrompt = value;
      },
    };
    const tab = {
      playwright: {
        locator(selector) {
          expect(selector).toBe("main");
          return {
            getByRole(role) {
              expect(role).toBe("textbox");
              return box;
            },
          };
        },
      },
      async url() {
        return "https://chatgpt.com/c/6abedf2c-47f0-83e9-aae0-02cba87d222b";
      },
    };

    const result = await sendToExistingConsult({
      tab,
      prompt: "Follow up without changing modes.",
      send: false,
    });

    expect(typedPrompt).toBe("Follow up without changing modes.");
    expect(result).toEqual({
      status: "existing_session_prepared_not_sent",
      attachments: [],
      tab,
      url: "https://chatgpt.com/c/6abedf2c-47f0-83e9-aae0-02cba87d222b",
    });

    tab.url = async () => "https://chatgpt.com/c/local-chatgpt%3A07ca6f60-2752-43bd-8c8b-a539c6c5d00a";
    const pending = await sendToExistingConsult({ tab, prompt: "Cloud persistence is pending.", send: false });
    expect(pending.status).toBe("existing_session_prepared_not_sent");
    expect(pending.url).toBeUndefined();
  });

  it("clears an existing draft without confirmation before preparing the follow-up", async () => {
    let composerText = "Old draft that must be replaced.";
    const box = {
      async count() {
        return 1;
      },
      filter() {
        return this;
      },
      async innerText() {
        return composerText;
      },
      async fill(value) {
        composerText = value;
      },
      async type(value) {
        composerText += value;
      },
    };
    const tab = {
      playwright: {
        locator(selector) {
          expect(selector).toBe("main");
          return {
            getByRole(role) {
              expect(role).toBe("textbox");
              return box;
            },
          };
        },
      },
      async url() {
        return "https://chatgpt.com/c/6abedf2c-47f0-83e9-aae0-02cba87d222b";
      },
    };

    const result = await sendToExistingConsult({
      tab,
      prompt: "Replacement prompt.",
      send: false,
    });

    expect(composerText).toBe("Replacement prompt.");
    expect(result.status).toBe("existing_session_prepared_not_sent");
  });
});

describe("verifyAnswerModel", () => {
  function answerTab({ regenerateButtons = 1, label = "Try again • 6 Pro" } = {}) {
    const events = [];
    const tab = {
      async pressKey(target, key) { events.push(`key:${key}`); },
      playwright: {
        async domSnapshot() {},
        getByRole(role, options) {
          if (role === "button") {
            expect(options).toEqual({ name: "Regenerate response", exact: true });
            return {
              async count() { return regenerateButtons; },
              last() { return { async click() { events.push("open"); } }; },
            };
          }
          expect(role).toBe("menuitem");
          return {
            filter(options) {
              expect(options.hasText.test(label)).toBe(true);
              return { async count() { return 1; }, async innerText() { return label; } };
            },
          };
        },
      },
    };
    return { tab, events };
  }

  it("reads the answer model from the regenerate menu and closes it", async () => {
    const { tab, events } = answerTab();
    expect(await verifyAnswerModel(tab)).toEqual({ status: "verified", model: "6 Pro", expectedModel: "6 Pro" });
    expect(events).toEqual(["open", "key:Escape"]);
  });

  it("reports a model mismatch", async () => {
    const { tab } = answerTab({ label: "Try again • 6 Thinking" });
    expect((await verifyAnswerModel(tab)).status).toBe("model_mismatch");
  });

  it("does not open a menu before the answer is complete", async () => {
    const { tab, events } = answerTab({ regenerateButtons: 0 });
    expect(await verifyAnswerModel(tab)).toEqual({ status: "answer_not_complete" });
    expect(events).toEqual([]);
  });
});

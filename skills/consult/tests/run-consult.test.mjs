import { describe, expect, it } from "bun:test";
import {
  attachGitHubPlugin,
  ensureChatMode,
  enableImageMode,
  ensureThinkingLevel,
  sendToExistingConsult,
  startConsult,
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
  function thinkingTab(initialLabel = "5.6 Pro") {
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
    const menu = {
      async count() { return menuOpen ? 1 : 0; },
      async isVisible() { return menuOpen; },
      async waitFor() { expect(menuOpen).toBe(true); },
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
          if (selector === '[role="menuitemradio"]') return {
            filter(options) {
              expect(options.hasText.test("Latest")).toBe(true);
              return latestRadio;
            },
          };
          expect(selector).toBe('[role="menuitem"][aria-label="Select model"]');
          return {
            async count() { return menuOpen ? 1 : 0; },
            async innerText() { return latestSelected ? "6Pro" : "5.6Pro"; },
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

  it("changes an alternate Pro model to 6 Pro and verifies Latest", async () => {
    const {tab, state} = thinkingTab();
    expect(await ensureThinkingLevel(tab, "pro")).toEqual({
      thinkingLevel: "pro",
      mode: "Pro",
      model: "GPT-6",
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

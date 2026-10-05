import { prepareUploadPaths } from "./prepare-uploads.mjs";

const CHATGPT_URL = "https://chatgpt.com/";
const FALLBACK_PROJECT = "Consult";

function normalized(value) {
  return String(value).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

async function requireOne(locator, description) {
  const count = await locator.count();
  if (count !== 1) throw new Error(`Expected exactly one ${description}; found ${count}.`);
  return locator;
}

async function visible(locator) {
  const count = await locator.count();
  return count === 1 && await locator.isVisible();
}

async function conversationUrl(tab) {
  const url = await tab.url();
  const id = new URL(url).pathname.split("/c/")[1];
  // A newly submitted Chat first uses a local-chatgpt ID before cloud persistence finishes.
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? "") ? url : undefined;
}

export async function ensureChatMode(tab) {
  await tab.playwright.domSnapshot();
  const surface = tab.playwright.getByRole("group", {
    name: "Composer mode",
    exact: true,
  });
  try {
    await surface.waitFor({ state: "visible", timeoutMs: 15000 });
  } catch {
    const snapshot = await tab.playwright.domSnapshot();
    if (/\bLog in\b|\bSign up\b/i.test(snapshot)) return { status: "authentication_required" };
    throw new Error("ChatGPT did not expose the Chat/Work surface selector within 15 seconds.");
  }
  await requireOne(surface, "Chat/Work surface selector");

  const chat = surface.getByRole("button", { name: "Chat", exact: true });
  await requireOne(chat, "Chat surface option");
  if (await chat.getAttribute("aria-pressed") !== "true") {
    await chat.click();
    await tab.playwright.domSnapshot();
  }

  if (
    await chat.getAttribute("aria-pressed") !== "true"
    || !await chat.isVisible()
  ) {
    throw new Error("ChatGPT Chat mode could not be selected.");
  }
  return { status: "chat_selected", chatSurface: "chat" };
}

async function actualProjectLabel(tab, requested) {
  const wanted = normalized(requested);
  const labels = await tab.playwright.evaluate((target) => {
    const values = [];
    for (const element of Array.from(document.querySelectorAll("button,[role='button']"))) {
      const text = (element.textContent || "").trim().replace(/\s+/g, " ");
      if (text && text.normalize("NFKC").toLowerCase() === target) values.push(text);
    }
    return Array.from(new Set(values));
  }, wanted);
  return labels.length === 1 ? labels[0] : null;
}

async function findProject(tab, requested) {
  const label = await actualProjectLabel(tab, requested);
  if (!label) return null;
  const locator = tab.playwright.getByRole("button", { name: label, exact: true });
  return await locator.count() === 1 ? { label, locator } : null;
}

async function waitForProject(tab, requested) {
  const escaped = requested.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const control = tab.playwright.getByRole("button", { name: new RegExp(`^${escaped}$`, "i") });
  try {
    await control.waitFor({ state: "visible", timeoutMs: 15000 });
  } catch {
    return null;
  }
  return findProject(tab, requested);
}

async function openProject(tab, project) {
  await tab.playwright.domSnapshot();
  // A fresh ChatGPT tab can render its shell before the project list hydrates.
  // Wait for the requested control before deciding that fallback is necessary.
  let target = await waitForProject(tab, project);

  if (!target) {
    const more = tab.playwright.getByText("More", { exact: true });
    const moreCount = await more.count();
    if (moreCount === 1 && await more.isVisible()) {
      await more.click();
      await tab.playwright.domSnapshot();
      target = await findProject(tab, project);
    }
  }

  if (!target) {
    const snapshot = await tab.playwright.domSnapshot();
    if (/\bLog in\b|\bSign up\b/i.test(snapshot)) {
      return { status: "authentication_required", requestedProject: project };
    }
    return { status: "project_not_found", requestedProject: project, fallbackProject: FALLBACK_PROJECT };
  }

  const actions = tab.playwright.getByRole("button", {
    name: `Project actions for ${target.label}`, exact: true,
  });
  // Sidebar action buttons are revealed on hover; keyboard activation targets the button directly.
  await (await requireOne(actions, `project actions for ${target.label}`)).press("Space");
  await tab.playwright.domSnapshot();
  const menu = tab.playwright.getByRole("menu", {
    name: `Project actions for ${target.label}`, exact: true,
  });
  await menu.waitFor({ state: "visible", timeoutMs: 15000 });
  const home = tab.playwright.getByRole("menuitem", { name: "Project home", exact: true });
  await home.waitFor({ state: "visible", timeoutMs: 5000 });
  await (await requireOne(home, `project-home control for ${project}`)).click();
  const composerName = `New chat in ${target.label}`;

  // Project navigation and composer mounting are asynchronous. Waiting on the
  // actual accessible textbox avoids a false failure from an early snapshot.
  const projectComposer = tab.playwright.getByRole("textbox", { name: composerName, exact: true });
  try {
    await projectComposer.waitFor({ state: "visible", timeoutMs: 15000 });
  } catch {
    throw new Error(`Project home did not expose ${composerName} within 15 seconds.`);
  }
  await requireOne(projectComposer, `project composer ${composerName}`);
  return { status: "project_open", composerName };
}

async function composer(tab, composerName) {
  return requireOne(
    tab.playwright.getByRole("textbox", { name: composerName, exact: true }),
    `project composer ${composerName}`,
  );
}

async function activeConversationComposer(tab) {
  const boxes = tab.playwright.locator("main").getByRole("textbox").filter({ visible: true });
  return requireOne(boxes, "active conversation composer");
}

async function emptyComposer(box) {
  const existingText = (await box.innerText() || "").trim();
  if (existingText) {
    await box.fill("");
    if ((await box.innerText() || "").trim()) {
      throw new Error("Could not clear the existing ChatGPT composer draft.");
    }
  }
}

async function chooseLocalFiles(tab, paths) {
  const add = tab.playwright.getByRole("button", { name: "Add files and more", exact: true });
  await (await requireOne(add, "Add files and more button")).click();
  await tab.playwright.domSnapshot();
  const upload = tab.playwright.getByRole("button", {
    name: "Add photos & files Upload from computer", exact: true,
  });
  const uniqueUpload = await requireOne(upload, "Upload from computer option");
  const chooserPromise = tab.playwright.waitForEvent("filechooser", { timeoutMs: 10000 });
  await uniqueUpload.click();
  const chooser = await chooserPromise;
  if (!chooser.isMultiple() && paths.length > 1) {
    throw new Error("ChatGPT's file chooser does not allow multiple files in this session.");
  }
  await chooser.setFiles(paths, { timeoutMs: 120000 });
}

async function waitForUploadReady(tab) {
  const sendButton = tab.playwright.getByRole("button", { name: "Send", exact: true });
  await sendButton.waitFor({ state: "visible", timeoutMs: 120000 });
  const deadline = Date.now() + 120000;
  while (!await sendButton.isEnabled()) {
    if (Date.now() >= deadline) throw new Error("ChatGPT did not finish preparing the file upload within 120 seconds.");
    await tab.playwright.waitForTimeout(250);
  }
}

async function attachPreparedFiles(tab, prepared) {
  if (prepared.files.length === 0) return;
  await chooseLocalFiles(tab, prepared.files);
  await tab.playwright.domSnapshot();
  for (const source of prepared.sources) {
    for (const upload of source.uploads) {
      const attachment = tab.playwright.getByRole("button", { name: `Remove ${upload.name}`, exact: true });
      await attachment.waitFor({ state: "visible", timeoutMs: 120000 });
      await requireOne(attachment, `uploaded attachment ${upload.name}`);
      await tab.playwright.getByRole("progressbar", {
        name: `Uploading ${upload.name}`, exact: true,
      }).waitFor({ state: "hidden", timeoutMs: 120000 });
    }
  }
  await waitForUploadReady(tab);
}

async function sendCurrentComposer(tab) {
  const sendButton = tab.playwright.getByRole("button", { name: "Send", exact: true });
  await sendButton.waitFor({ state: "visible", timeoutMs: 30000 });
  const uniqueSend = await requireOne(sendButton, "Send button");
  const deadline = Date.now() + 30000;
  while (!await uniqueSend.isEnabled()) {
    if (Date.now() >= deadline) throw new Error("Send button remained disabled for 30 seconds.");
    await tab.playwright.waitForTimeout(250);
  }
  await uniqueSend.click();
}

export async function attachGitHubPlugin(tab, composerName) {
  const box = await composer(tab, composerName);
  const existingText = (await box.textContent() || "").trim();
  if (existingText) {
    await box.fill("");
    if ((await box.textContent() || "").trim()) throw new Error("Could not clear the project composer.");
  }

  const add = tab.playwright.getByRole("button", { name: "Add files and more", exact: true });
  await (await requireOne(add, "Add files and more button")).click();
  await tab.playwright.domSnapshot();
  const github = tab.playwright.getByRole("button", { name: /^GitHub\b/ });
  await github.waitFor({ state: "visible", timeoutMs: 15000 });
  await (await requireOne(github, "GitHub attachment option")).click();
  await tab.playwright.domSnapshot();

  const pill = (await composer(tab, composerName)).getByText("GitHub", { exact: true });
  await pill.waitFor({ state: "visible", timeoutMs: 5000 });
  if (!await pill.isVisible()) throw new Error("GitHub plugin pill was not visibly attached.");
}

export async function enableImageMode(tab, aspectRatio) {
  const add = tab.playwright.getByRole("button", { name: "Add files and more", exact: true });
  await (await requireOne(add, "Add files and more button")).click();
  await tab.playwright.domSnapshot();
  const create = tab.playwright.getByText("Create image", { exact: true });
  await (await requireOne(create, "Create image option")).click();
  await tab.playwright.domSnapshot();

  const pill = tab.playwright.locator(
    '[data-inline-selection-pill][data-id="picture_v2"][data-keyword="Create image"]',
  );
  await pill.waitFor({ state: "visible", timeoutMs: 5000 });
  await requireOne(pill, "Create image mode pill");
  if (!await pill.isVisible()) throw new Error("Create image mode pill was not visibly attached.");

  if (aspectRatio) {
    const ratioButton = tab.playwright.getByRole("button", { name: "Choose image aspect ratio", exact: true });
    if (await visible(ratioButton)) {
      await ratioButton.click();
      await tab.playwright.domSnapshot();
      const ratio = tab.playwright.getByText(aspectRatio, { exact: true });
      await (await requireOne(ratio, `image aspect ratio ${aspectRatio}`)).click();
      return { promptPrefix: "" };
    }

    return { promptPrefix: `Create the image at a ${aspectRatio} aspect ratio.\n\n` };
  }

  return { promptPrefix: "" };
}

const THINKING_LEVELS = new Map([
  ["instant", { label: "Instant", power: 0 }],
  ["medium", { label: "Medium", power: 1 }],
  ["high", { label: "High", power: 2 }],
  ["extra high", { label: "Extra High", power: 3 }],
  ["extra-high", { label: "Extra High", power: 3 }],
  ["pro", { label: "6 Pro", power: 4 }],
]);

function normalizeThinkingLevel(value) {
  const normalizedValue = String(value).normalize("NFKC").trim().toLowerCase();
  const level = THINKING_LEVELS.get(normalizedValue);
  if (!level) {
    throw new Error(`Unsupported thinkingLevel ${JSON.stringify(value)}. Expected instant, medium, high, extra-high, or pro.`);
  }
  return { value: normalizedValue === "extra high" ? "extra-high" : normalizedValue, ...level };
}

export async function ensureThinkingLevel(tab, thinkingLevel = "pro") {
  const requested = normalizeThinkingLevel(thinkingLevel);
  const control = tab.playwright.getByRole("button", { name: "Select ChatGPT model", exact: true });
  await (await requireOne(control, "model and thinking selector")).click();
  await tab.playwright.domSnapshot();
  const menu = tab.playwright.getByRole("menu", { name: "Select ChatGPT model", exact: true });
  await menu.waitFor({ state: "visible", timeoutMs: 5000 });
  // The power slider has aria-hidden=true; its DOM role is still keyboard operable.
  let slider = tab.playwright.locator('[role="slider"]');
  await requireOne(slider, "thinking-level power slider");
  if (Number(await slider.getAttribute("aria-valuenow")) !== requested.power) {
    await (await requireOne(slider, "thinking-level power slider")).press("Home");
    for (let power = 0; power < requested.power; power += 1) {
      await tab.playwright.domSnapshot();
      slider = tab.playwright.locator('[role="slider"]');
      await (await requireOne(slider, "thinking-level power slider")).press("ArrowRight");
    }
    await tab.playwright.domSnapshot();
  }

  if (requested.value === "pro") {
    const latestRadio = tab.playwright.locator('[role="menuitemradio"]').filter({ hasText: /^Latest$/ });
    await requireOne(latestRadio, "Latest model option");
    if (await latestRadio.getAttribute("aria-checked") !== "true") {
      await latestRadio.press("Space");
      await tab.playwright.domSnapshot();
    }
    if (!await visible(menu)) {
      await control.click();
      await tab.playwright.domSnapshot();
    }
    if (await latestRadio.getAttribute("aria-checked") !== "true") {
      throw new Error("Latest Pro model was not selected.");
    }
    const modelPicker = tab.playwright.locator('[role="menuitem"][aria-label="Select model"]');
    await requireOne(modelPicker, "selected model label");
    if ((await modelPicker.innerText()).replace(/\s+/g, "") !== "6Pro") {
      throw new Error("The selected Latest model is not 6 Pro.");
    }
  }
  slider = tab.playwright.locator('[role="slider"]');
  if (Number(await slider.getAttribute("aria-valuenow")) !== requested.power) {
    throw new Error(`${requested.label} power was not selected.`);
  }
  await control.click();
  await tab.playwright.domSnapshot();
  if (await visible(menu)) throw new Error("The model selector did not close.");

  if (requested.value !== "pro") return { thinkingLevel: requested.value, mode: requested.label };
  return { thinkingLevel: requested.value, mode: "Pro", model: "GPT-6" };
}

export async function startConsult({ iab, project, prompt, paths = [], send = true, createImage = false, aspectRatio = null, thinkingLevel = "pro", attachGitHub = true, maxUploadBytes }) {
  if (!iab || !project || !prompt) throw new Error("iab, project, and prompt are required.");
  if (createImage && attachGitHub) {
    throw new Error(
      "ChatGPT image mode cannot remain active with the GitHub plugin attached. Set attachGitHub to false and provide needed context through the prompt or paths.",
    );
  }
  thinkingLevel = normalizeThinkingLevel(thinkingLevel).value;
  const prepared = prepareUploadPaths(paths, { maxUploadBytes });
  let tab;
  let ownedComposerName;
  try {
    tab = await iab.tabs.new();
    await tab.goto(CHATGPT_URL);

    const surfaceSelection = await ensureChatMode(tab);
    if (surfaceSelection.status === "authentication_required") return { ...surfaceSelection, tab };

    const requestedProject = project;
    let selectedProject = project;
    let usedFallbackProject = false;
    let opened = await openProject(tab, selectedProject);
    if (opened.status === "project_not_found" && normalized(selectedProject) !== normalized(FALLBACK_PROJECT)) {
      selectedProject = FALLBACK_PROJECT;
      usedFallbackProject = true;
      opened = await openProject(tab, selectedProject);
    }
    if (opened.status !== "project_open") return { ...opened, tab };

    await emptyComposer(await composer(tab, opened.composerName));
    ownedComposerName = opened.composerName;
    if (attachGitHub) await attachGitHubPlugin(tab, opened.composerName);
    const imageMode = createImage
      ? await enableImageMode(tab, aspectRatio)
      : { promptPrefix: "" };
    const modelSelection = await ensureThinkingLevel(tab, thinkingLevel);
    const box = await composer(tab, opened.composerName);
    await attachPreparedFiles(tab, prepared);

    if (!send) return {
      status: "setup_verified_not_sent",
      project: selectedProject,
      requestedProject,
      usedFallbackProject,
      githubAttached: attachGitHub,
      attachments: prepared.sources,
      chatSurface: surfaceSelection.chatSurface,
      ...modelSelection,
      tab,
    };

    await box.type(`${imageMode.promptPrefix}${prompt}`);

    if (attachGitHub) {
      const githubPill = box.getByText("GitHub", { exact: true });
      if (!await visible(githubPill)) throw new Error("GitHub pill was not visible immediately before send.");
    }
    await sendCurrentComposer(tab);
    await tab.playwright.waitForURL("**/c/**", { timeoutMs: 15000 });

    return {
      status: "sent",
      project: selectedProject,
      requestedProject,
      usedFallbackProject,
      githubAttached: attachGitHub,
      attachments: prepared.sources,
      chatSurface: surfaceSelection.chatSurface,
      ...modelSelection,
      tab,
      url: await conversationUrl(tab),
    };
  } catch (error) {
    if (tab && ownedComposerName) {
      try {
        await tab.playwright.domSnapshot();
        const ownedComposer = await composer(tab, ownedComposerName);
        await ownedComposer.fill("");
        await tab.playwright.domSnapshot();
      } catch {
        // Preserve the original hard-gate error when best-effort cleanup fails.
      }
    }
    throw error;
  } finally {
    prepared.cleanup();
  }
}

export async function sendToExistingConsult({ session, tab = session?.tab, paths = [], prompt = "", send = true, maxUploadBytes }) {
  if (!tab) throw new Error("An existing consult session or tab is required.");
  if (!prompt && (typeof paths === "string" ? !paths : paths.length === 0)) {
    throw new Error("Provide at least one attachment path or a prompt for the existing session.");
  }
  const prepared = prepareUploadPaths(paths, { maxUploadBytes });
  try {
    const box = await activeConversationComposer(tab);
    await emptyComposer(box);
    await attachPreparedFiles(tab, prepared);
    if (prompt) await box.type(prompt);

    if (!send) return {
      status: "existing_session_prepared_not_sent",
      attachments: prepared.sources,
      tab,
      url: await conversationUrl(tab),
    };

    await sendCurrentComposer(tab);
    return {
      status: "sent_to_existing_session",
      attachments: prepared.sources,
      tab,
      url: await conversationUrl(tab),
    };
  } finally {
    prepared.cleanup();
  }
}

export async function sendExpectedExistingDraft({ session, tab = session?.tab, expectedPrompt }) {
  if (!tab) throw new Error("An existing consult session or tab is required.");
  if (!expectedPrompt) throw new Error("An expected prompt is required.");
  const box = await activeConversationComposer(tab);
  const existingText = (await box.innerText() || "").trim();
  const normalizeVisibleText = (value) => value.replace(/\s+/g, " ").trim();
  if (normalizeVisibleText(existingText) !== normalizeVisibleText(expectedPrompt)) {
    throw new Error("The staged ChatGPT draft does not exactly match the expected prompt; refusing to send it.");
  }
  await sendCurrentComposer(tab);
  return { status: "sent_expected_existing_draft", tab, url: await conversationUrl(tab) };
}

export function publicResult(session) {
  const { tab, ...result } = session;
  return result;
}

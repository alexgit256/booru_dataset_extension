import { MESSAGE_TYPES } from "./config.js";

const form = document.getElementById("settings-form");
const workingDirectoryInput = document.getElementById("workingDirectory");
const digitsInput = document.getElementById("digits");
const imagePrefixInput = document.getElementById("imagePrefix");
const tagFileExtensionInput = document.getElementById("tagFileExtension");
const captureButton = document.getElementById("captureButton");
const statusEl = document.getElementById("status");

init().catch((error) => setStatus(`Initialization failed: ${error.message}`));

async function init() {
  const response = await sendMessage({ type: MESSAGE_TYPES.GET_SETTINGS });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not load settings.");
  }

  const { settings } = response;
  workingDirectoryInput.value = settings.workingDirectory;
  digitsInput.value = settings.digits;
  imagePrefixInput.value = settings.imagePrefix || "";
  tagFileExtensionInput.value = settings.tagFileExtension || "txt";

  form.addEventListener("submit", onSaveSettings);
  captureButton.addEventListener("click", onCaptureCurrentPost);
}

async function onSaveSettings(event) {
  event.preventDefault();

  const payload = {
    workingDirectory: workingDirectoryInput.value,
    digits: Number(digitsInput.value),
    imagePrefix: imagePrefixInput.value,
    tagFileExtension: tagFileExtensionInput.value
  };

  setStatus("Saving settings...");
  const response = await sendMessage({
    type: MESSAGE_TYPES.SAVE_SETTINGS,
    payload
  });

  if (!response?.ok) {
    setStatus(`Failed to save settings: ${response?.error || "Unknown error"}`);
    return;
  }

  setStatus(`Saved settings.\nDirectory: ${response.settings.workingDirectory}\nDigits: ${response.settings.digits}`);
}

async function onCaptureCurrentPost() {
  setStatus("Capturing current post...");
  const response = await sendMessage({ type: MESSAGE_TYPES.CAPTURE_CURRENT_POST });

  if (!response?.ok) {
    setStatus(`Capture failed:\n${response?.error || "Unknown error"}`);
    return;
  }

  const { saved, formatted } = response;
  setStatus(
    [
      "Saved successfully.",
      `Index: ${saved.index}`,
      `Image: ${saved.imageFilename}`,
      `Tags: ${saved.textFilename}`,
      `Directory: ${saved.workingDirectory}`,
      `Formatted tags: ${formatted.output}`
    ].join("\n")
  );
}

async function sendMessage(message) {
  return await chrome.runtime.sendMessage(message);
}

function setStatus(text) {
  statusEl.textContent = text;
}

export const DEFAULT_SETTINGS = {
  workingDirectory: "booru_dataset",
  digits: 4,
  imagePrefix: "",
  tagFileExtension: "txt"
};

export const STORAGE_KEYS = {
  settings: "settings",
  nextIndexByDirectory: "nextIndexByDirectory"
};

export const MESSAGE_TYPES = {
  GET_SETTINGS: "GET_SETTINGS",
  SAVE_SETTINGS: "SAVE_SETTINGS",
  CAPTURE_CURRENT_POST: "CAPTURE_CURRENT_POST",
  CAPTURE_CURRENT_TAGS_ONLY: "CAPTURE_CURRENT_TAGS_ONLY",
  CACHE_RULE34US_IMAGE: "CACHE_RULE34US_IMAGE"
};

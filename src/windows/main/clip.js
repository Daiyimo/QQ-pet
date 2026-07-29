const { clipboard } = require("electron");

module.exports = function (options) {
  options = options || {};
  const watchDelay = options.watchDelay || 1000;
  const shakeTime = options.shakeTime || 0;

  const readThumbnail = (image) => {
    try {
      return image.resize({ width: 16, height: 16, quality: "good" }).toPNG();
    } catch (err) {
      console.warn("Failed to build clipboard thumbnail:", err);
      return null;
    }
  };

  let lastText = "";
  let lastImage = null;
  let cachedThumb = null;

  let delayTimeout = null;
  let wasStopped = true; // Initialize to true so the first active tick resets baselines without triggering

  const intervalId = setInterval(() => {
    const stopped = options.stop && options.stop("clip");
    if (stopped) {
      wasStopped = true;
      return;
    }

    if (wasStopped) {
      // Resuming intentionally resets baselines, so changes while stopped are not replayed.
      lastText = clipboard.readText();
      lastImage = clipboard.readImage();
      cachedThumb = lastImage.isEmpty() ? null : readThumbnail(lastImage);
      wasStopped = false;
      return;
    }

    // 1. Check text change
    if (options.onTextChange) {
      const currentText = clipboard.readText();
      // Match the original logic: trigger only if currentText is not empty and has changed
      if (currentText && lastText !== currentText) {
        lastText = currentText;
        if (delayTimeout) clearTimeout(delayTimeout);
        delayTimeout = setTimeout(() => {
          options.onTextChange(currentText);
          delayTimeout = null;
        }, shakeTime);
        return;
      }
    }

    // 2. Check image change
    if (options.onImageChange) {
      const currentImage = clipboard.readImage();
      const currentEmpty = currentImage.isEmpty();
      const cachedEmpty = lastImage.isEmpty();

      if (!currentEmpty) {
        let changed = false;
        let currentThumb = null;

        if (cachedEmpty) {
          changed = true;
        } else {
          const currentSize = currentImage.getSize();
          const cachedSize = lastImage.getSize();
          if (currentSize.width !== cachedSize.width || currentSize.height !== cachedSize.height) {
            changed = true;
          } else {
            // Performance tradeoff: avoid full image serialization on every tick.
            // Same-sized images that collide after 16x16 downscaling may be missed.
            currentThumb = readThumbnail(currentImage);
            if (!cachedThumb || !currentThumb || !cachedThumb.equals(currentThumb)) {
              changed = true;
            }
          }
        }

        if (changed) {
          lastImage = currentImage;
          if (!currentThumb) {
            currentThumb = readThumbnail(currentImage);
          }
          cachedThumb = currentThumb;

          if (delayTimeout) clearTimeout(delayTimeout);
          delayTimeout = setTimeout(() => {
            options.onImageChange(currentImage);
            delayTimeout = null;
          }, shakeTime);
        }
      } else if (!cachedEmpty) {
        lastImage = currentImage;
        cachedThumb = null;
      }
    }
  }, watchDelay);

  return {
    stop: () => clearInterval(intervalId),
  };
};

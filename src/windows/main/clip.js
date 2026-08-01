const { clipboard } = require("electron");

// 默认轮询周期。依据：每 tick 至少一次 clipboard.readText() + readFormats()，在 Windows 上
// 都是主进程同步的 OpenClipboard —— 剪贴板是独占资源，高频占用会让其他程序的复制/粘贴
// 间歇失败（Office / 远程桌面的经典症状）。曾用的 200ms = 5 次/秒 = 18000 次/小时 =
// 216000 次/12 小时，收益却为零：人手复制后 1 秒内响应完全够用。
const DEFAULT_WATCH_DELAY_MS = 1000;

module.exports = function (options) {
  options = options || {};
  const watchDelay = options.watchDelay || DEFAULT_WATCH_DELAY_MS;
  const shakeTime = options.shakeTime || 0;

  const readThumbnail = (image) => {
    try {
      return image.resize({ width: 16, height: 16, quality: "good" }).toPNG();
    } catch (err) {
      console.warn("[main/clip] 生成剪贴板缩略图失败，本次改动按「无缩略图」比较:", err?.message || err);
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
      // 便宜预检：剪贴板不含图片格式且缓存也为空时，跳过昂贵的 readImage
      const formats = clipboard.readFormats();
      const hasImage = formats.some((f) => {
        const lower = f.toLowerCase();
        return lower.includes("image") || lower.includes("bitmap") || lower.includes("dib") || lower === "png";
      });
      if (!hasImage && lastImage.isEmpty()) return;

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

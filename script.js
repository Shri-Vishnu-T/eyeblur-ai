"use strict";

/* ==========================================================================
   1. APPLICATION BOOT
   ========================================================================== */

document.addEventListener("DOMContentLoaded", () => {
  try {
    App.init();
  } catch (err) {
    console.error("Fatal initialization error:", err);
    ToastManager.show("Something went wrong while starting the app.", "error");
  }
});

/* ==========================================================================
   2. DOM CACHE
   ========================================================================== */

const DOM = {
  background: document.querySelector(".background"),
  particleCanvas: document.getElementById("particleCanvas"),
  cursorGlow: document.getElementById("cursorGlow"),

  dropZone: document.getElementById("dropZone"),
  imageInput: document.getElementById("imageInput"),
  browseButton: document.getElementById("browseButton"),

  previewGrid: document.getElementById("previewGrid"),

  processButton: document.getElementById("processButton"),

  progressSection: document.getElementById("progressSection"),
  progressFill: document.getElementById("progressFill"),
  progressText: document.getElementById("progressText"),

  resultGrid: document.getElementById("resultGrid"),
  downloadZip: document.getElementById("downloadZip"),

  toast: document.getElementById("toast"),
  loader: document.getElementById("loader"),

  navbar: document.querySelector(".navbar"),
};

/* ==========================================================================
   3. CONFIGURATION
   ========================================================================== */

const CONFIG = Object.freeze({
  MAX_IMAGES: 5,
  MAX_FILE_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  ACCEPTED_MIME_TYPES: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  JPEG_EXPORT_QUALITY: 0.95,
  TOAST_DURATION_MS: 4200,
  MODEL_URL:
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  WASM_BASE_URL:
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm",
  MEDIAPIPE_VISION_MODULE:
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14",
  BLUR_PADDING_RATIO: 0.55, // extra padding around the eye bounding box, relative to eye width
  BLUR_STRENGTH_DIVISOR: 18, // used to scale blur radius relative to image size
  MIN_BLUR_PX: 6,
  MAX_BLUR_PX: 60,
  PARTICLE_COUNT_DESKTOP: 70,
  PARTICLE_COUNT_MOBILE: 32,
  PARTICLE_LINK_DISTANCE: 130,
  PARTICLE_MOUSE_REPEL_RADIUS: 120,
  RETRY_LIMIT: 2,
});

/* Left/right eye contour landmark index groups from MediaPipe FaceLandmarker (468-point mesh). */
const EYE_LANDMARK_INDICES = Object.freeze({
  left: Object.freeze([
    33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
  ]),
  right: Object.freeze([
    263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
  ]),
});

/* ==========================================================================
   4. UTILITIES
   ========================================================================== */

const Utils = {
  /**
   * Clamp a numeric value between a min and max.
   */
  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  },

  /**
   * Format bytes into a human readable string.
   */
  formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  },

  /**
   * Strip an extension from a filename and return { base, ext }.
   */
  splitFilename(filename) {
    const dotIndex = filename.lastIndexOf(".");
    if (dotIndex <= 0) return { base: filename, ext: "jpg" };
    return {
      base: filename.slice(0, dotIndex),
      ext: filename.slice(dotIndex + 1),
    };
  },

  /**
   * Generate a short unique id.
   */
  uid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  },

  /**
   * Debounce a function call.
   */
  debounce(fn, wait) {
    let timeoutId = null;
    return (...args) => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => fn(...args), wait);
    };
  },

  /**
   * Throttle a function call using requestAnimationFrame.
   */
  rafThrottle(fn) {
    let scheduled = false;
    let lastArgs = null;
    return (...args) => {
      lastArgs = args;
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        fn(...lastArgs);
      });
    };
  },

  /**
   * Yield control back to the browser event loop.
   */
  yieldToBrowser() {
    return new Promise((resolve) => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => resolve(), { timeout: 100 });
      } else {
        window.setTimeout(resolve, 0);
      }
    });
  },

  /**
   * Read image natural dimensions + create an ImageBitmap or HTMLImageElement.
   */
  async loadImageBitmap(file) {
    if ("createImageBitmap" in window) {
      try {
        const bitmap = await window.createImageBitmap(file);
        return bitmap;
      } catch {
        // fall through to HTMLImageElement fallback
      }
    }
    return await Utils.loadHtmlImage(file);
  },

  loadHtmlImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Unable to decode image."));
      };
      img.src = url;
    });
  },

  isMobileViewport() {
    return window.innerWidth <= 768;
  },
};

/* ==========================================================================
   5. TOAST MANAGER
   ========================================================================== */

const ToastManager = (() => {
  const ICONS = {
    success: "fa-solid fa-circle-check",
    error: "fa-solid fa-circle-exclamation",
    warning: "fa-solid fa-triangle-exclamation",
    info: "fa-solid fa-circle-info",
  };

  /**
   * Display a toast message. Stacks automatically inside #toast.
   */
  function show(message, type = "info", duration = CONFIG.TOAST_DURATION_MS) {
    if (!DOM.toast) return;

    const item = document.createElement("div");
    item.className = `toast-item ${type}`;
    item.setAttribute("role", "status");
    item.setAttribute("aria-live", "polite");

    const icon = document.createElement("i");
    icon.className = ICONS[type] ?? ICONS.info;

    const text = document.createElement("span");
    text.textContent = message;

    item.append(icon, text);
    DOM.toast.appendChild(item);

    const remove = () => {
      item.classList.add("hide");
      item.addEventListener(
        "animationend",
        () => {
          item.remove();
        },
        { once: true }
      );
    };

    window.setTimeout(remove, duration);
  }

  return { show };
})();

/* ==========================================================================
   6. LOADER MANAGER
   ========================================================================== */

const LoaderManager = (() => {
  let activeCount = 0;

  function show() {
    activeCount += 1;
    if (!DOM.loader) return;
    DOM.loader.classList.add("active");
    DOM.loader.setAttribute("aria-hidden", "false");
  }

  function hide() {
    activeCount = Math.max(0, activeCount - 1);
    if (!DOM.loader) return;
    if (activeCount === 0) {
      DOM.loader.classList.remove("active");
      DOM.loader.setAttribute("aria-hidden", "true");
    }
  }

  function forceHide() {
    activeCount = 0;
    if (!DOM.loader) return;
    DOM.loader.classList.remove("active");
    DOM.loader.setAttribute("aria-hidden", "true");
  }

  return { show, hide, forceHide };
})();

/* ==========================================================================
   7. UPLOAD MANAGER
   ========================================================================== */

const UploadManager = (() => {
  /**
   * Validate a single file against type/size rules.
   * Returns { valid: boolean, reason?: string }
   */
  function validateFile(file) {
    if (!CONFIG.ACCEPTED_MIME_TYPES.includes(file.type)) {
      return {
        valid: false,
        reason: `"${file.name}" is not a supported format. Use JPEG, PNG, or WEBP.`,
      };
    }
    if (file.size > CONFIG.MAX_FILE_SIZE_BYTES) {
      return {
        valid: false,
        reason: `"${file.name}" exceeds the 10MB size limit.`,
      };
    }
    if (file.size === 0) {
      return { valid: false, reason: `"${file.name}" appears to be corrupted.` };
    }
    return { valid: true };
  }

  /**
   * Filter a FileList/array of files, respecting the max image count,
   * and surface toast messages for anything rejected.
   */
  function filterIncomingFiles(fileList, currentCount) {
    const files = Array.from(fileList);
    const accepted = [];

    for (const file of files) {
      if (currentCount + accepted.length >= CONFIG.MAX_IMAGES) {
        ToastManager.show(
          `Maximum of ${CONFIG.MAX_IMAGES} images allowed. Some files were skipped.`,
          "warning"
        );
        break;
      }

      const result = validateFile(file);
      if (!result.valid) {
        ToastManager.show(result.reason, "error");
        continue;
      }

      accepted.push(file);
    }

    return accepted;
  }

  function handleFiles(fileList) {
    const currentCount = PreviewManager.getCount();
    const accepted = filterIncomingFiles(fileList, currentCount);
    if (accepted.length === 0) return;

    accepted.forEach((file) => PreviewManager.addImage(file));
    ToastManager.show(
      `${accepted.length} image${accepted.length > 1 ? "s" : ""} added.`,
      "success"
    );
  }

  function bindEvents() {
    if (!DOM.dropZone || !DOM.imageInput || !DOM.browseButton) return;

    DOM.browseButton.addEventListener("click", () => {
      DOM.imageInput.click();
    });

    DOM.imageInput.addEventListener("change", (event) => {
      const target = event.target;
      if (target.files && target.files.length > 0) {
        handleFiles(target.files);
      }
      target.value = "";
    });

    let dragCounter = 0;

    DOM.dropZone.addEventListener("dragenter", (event) => {
      event.preventDefault();
      dragCounter += 1;
      DOM.dropZone.classList.add("drag-active");
    });

    DOM.dropZone.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });

    DOM.dropZone.addEventListener("dragleave", (event) => {
      event.preventDefault();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) {
        DOM.dropZone.classList.remove("drag-active");
      }
    });

    DOM.dropZone.addEventListener("drop", (event) => {
      event.preventDefault();
      dragCounter = 0;
      DOM.dropZone.classList.remove("drag-active");
      if (event.dataTransfer?.files?.length) {
        handleFiles(event.dataTransfer.files);
      }
    });

    // Support Ctrl+V pasting of images anywhere on the page.
    document.addEventListener("paste", (event) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const imageFiles = [];
      for (const item of items) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        handleFiles(imageFiles);
      }
    });

    // Keyboard accessibility: Enter/Space on the drop zone opens the browser.
    DOM.dropZone.setAttribute("tabindex", "0");
    DOM.dropZone.setAttribute("role", "button");
    DOM.dropZone.setAttribute("aria-label", "Upload images by clicking, dragging, or pasting");
    DOM.dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        DOM.imageInput.click();
      }
    });
  }

  return { bindEvents, validateFile };
})();

/* ==========================================================================
   8. PREVIEW MANAGER
   ========================================================================== */

const PreviewManager = (() => {
  /** @type {Map<string, {file: File, url: string, width: number, height: number, element: HTMLElement}>} */
  const store = new Map();

  function getCount() {
    return store.size;
  }

  function getAll() {
    return Array.from(store.values());
  }

  function clear() {
    store.forEach((entry) => URL.revokeObjectURL(entry.url));
    store.clear();
    if (DOM.previewGrid) DOM.previewGrid.innerHTML = "";
    updateProcessButtonState();
  }

  async function addImage(file) {
    const id = Utils.uid();
    const url = URL.createObjectURL(file);

    const dims = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = url;
    });

    const card = buildCard(id, file, url, dims);
    store.set(id, { file, url, width: dims.width, height: dims.height, element: card });

    DOM.previewGrid?.appendChild(card);
    updateProcessButtonState();
  }

  function removeImage(id) {
    const entry = store.get(id);
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    entry.element.remove();
    store.delete(id);
    reindexCards();
    updateProcessButtonState();
  }

  function buildCard(id, file, url, dims) {
    const card = document.createElement("div");
    card.className = "preview-card";
    card.dataset.id = id;

    const img = document.createElement("img");
    img.src = url;
    img.alt = file.name;
    img.loading = "lazy";

    const info = document.createElement("div");
    info.className = "preview-info";

    const filename = document.createElement("div");
    filename.className = "filename";
    filename.textContent = file.name;
    filename.title = file.name;

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = `${dims.width}×${dims.height} • ${Utils.formatFileSize(file.size)}`;

    const removeBtn = document.createElement("button");
    removeBtn.className = "remove-btn";
    removeBtn.setAttribute("aria-label", `Remove ${file.name}`);
    removeBtn.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    removeBtn.addEventListener("click", () => removeImage(id));

    info.append(filename, meta, removeBtn);
    card.append(img, info);
    return card;
  }

  function reindexCards() {
    // Placeholder for future index-number badges if the grid order changes.
    let index = 1;
    store.forEach((entry) => {
      entry.element.dataset.index = String(index);
      index += 1;
    });
  }

  function updateProcessButtonState() {
    if (!DOM.processButton) return;
    DOM.processButton.disabled = store.size === 0;
  }

  return { addImage, removeImage, clear, getAll, getCount, updateProcessButtonState };
})();

/* ==========================================================================
   9. MEDIAPIPE MANAGER
   ========================================================================== */

const MediaPipeManager = (() => {
  let faceLandmarker = null;
  let initPromise = null;

  async function loadModule() {
    return await import(
      /* webpackIgnore: true */ CONFIG.MEDIAPIPE_VISION_MODULE
    );
  }

  async function init(retryCount = 0) {
    if (faceLandmarker) return faceLandmarker;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      try {
        LoaderManager.show();
        ToastManager.show("Loading AI model…", "info");

        const { FilesetResolver, FaceLandmarker } = await loadModule();

        const filesetResolver = await FilesetResolver.forVisionTasks(
          CONFIG.WASM_BASE_URL
        );

        faceLandmarker = await FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: CONFIG.MODEL_URL,
            delegate: "GPU",
          },
          runningMode: "IMAGE",
          numFaces: 5,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
        });

        ToastManager.show("AI model ready.", "success");
        return faceLandmarker;
      } catch (err) {
        console.error("MediaPipe initialization failed:", err);

        if (retryCount < CONFIG.RETRY_LIMIT) {
          initPromise = null;
          ToastManager.show("Retrying model load…", "warning");
          await new Promise((r) => window.setTimeout(r, 800));
          return init(retryCount + 1);
        }

        ToastManager.show(
          "Could not load the AI model. Check your connection and try again.",
          "error"
        );
        throw err;
      } finally {
        LoaderManager.hide();
      }
    })();

    return initPromise;
  }

  async function detect(imageSource) {
    if (!faceLandmarker) {
      throw new Error("FaceLandmarker has not been initialized.");
    }
    return faceLandmarker.detect(imageSource);
  }

  return { init, detect };
})();

/* ==========================================================================
   10. EYE DETECTION
   ========================================================================== */

const EyeDetection = (() => {
  /**
   * Convert normalized landmarks into pixel-space bounding info covering
   * BOTH eyes together (used to draw a single bar across both eyes).
   */
  function computeCombinedEyeRegion(landmarks, imageWidth, imageHeight) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    const allIndices = [...EYE_LANDMARK_INDICES.left, ...EYE_LANDMARK_INDICES.right];

    for (const idx of allIndices) {
      const point = landmarks[idx];
      if (!point) continue;
      const x = point.x * imageWidth;
      const y = point.y * imageHeight;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }

    if (!Number.isFinite(minX)) return null;

    const width = maxX - minX;
    const height = maxY - minY;

    // Horizontal padding: small, since minX/maxX already span from
    // outer-left-eye-corner to outer-right-eye-corner.
    const paddingX = width * 0.12;
    // Vertical padding: generous, so the bar fully covers both eyes
    // top-to-bottom like a censor bar.
    const paddingY = height * 0.9;

    return {
      x: minX - paddingX,
      y: minY - paddingY,
      width: width + paddingX * 2,
      height: height + paddingY * 2,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
    };
  }

  /**
   * Extract one combined eye-bar region per detected face.
   * Returns an array of region objects (one per face).
   */
  function extractEyeRegions(faceLandmarksList, imageWidth, imageHeight) {
    const regions = [];

    for (const landmarks of faceLandmarksList) {
      const region = computeCombinedEyeRegion(landmarks, imageWidth, imageHeight);
      if (region) regions.push(region);
    }

    return regions;
  }

  return { extractEyeRegions };
})();

/* ==========================================================================
   11. CANVAS BLUR ENGINE
   ========================================================================== */

const BlurEngine = (() => {
  /**
   * Compute an appropriate blur radius based on image resolution.
   */
  function computeBlurRadius(imageWidth, imageHeight) {
    const largestDimension = Math.max(imageWidth, imageHeight);
    const radius = largestDimension / CONFIG.BLUR_STRENGTH_DIVISOR;
    return Utils.clamp(radius, CONFIG.MIN_BLUR_PX, CONFIG.MAX_BLUR_PX);
  }

  /**
   * Draw the source image onto a canvas, then draw a solid black
   * rectangle ("censor bar") over each supplied combined eye region.
   */
  function applyEyeBlur(sourceImage, imageWidth, imageHeight, regions) {
    const canvas = document.createElement("canvas");
    canvas.width = imageWidth;
    canvas.height = imageHeight;
    const ctx = canvas.getContext("2d");

    ctx.drawImage(sourceImage, 0, 0, imageWidth, imageHeight);

    if (regions.length === 0) {
      return canvas;
    }

    for (const region of regions) {
      ctx.save();
      ctx.fillStyle = "#000000";
      ctx.fillRect(region.x, region.y, region.width, region.height);
      ctx.restore();
    }

    return canvas;
  }

  /**
   * Export a canvas to a Blob as JPEG at the configured quality.
   */
  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(blob);
          else reject(new Error("Canvas export failed."));
        },
        "image/jpeg",
        CONFIG.JPEG_EXPORT_QUALITY
      );
    });
  }

  return { applyEyeBlur, canvasToBlob, computeBlurRadius };
})();

/* ==========================================================================
   12. RESULT RENDERER
   ========================================================================== */

const ResultRenderer = (() => {
  /** @type {Array<{ name: string, blob: Blob, url: string }>} */
  const results = [];

  function clear() {
    results.forEach((entry) => URL.revokeObjectURL(entry.url));
    results.length = 0;
    if (DOM.resultGrid) DOM.resultGrid.innerHTML = "";
    updateZipButtonState();
  }

  function addResult(originalName, blob, originalUrl) {
    const url = URL.createObjectURL(blob);
    const { base, ext } = Utils.splitFilename(originalName);
    const downloadName = `${base}_blurred.jpg`;
    void ext;

    results.push({ name: downloadName, blob, url });

    const card = buildResultCard(originalUrl, url, downloadName);
    DOM.resultGrid?.appendChild(card);
    updateZipButtonState();
  }

  function buildResultCard(originalUrl, resultUrl, downloadName) {
    const card = document.createElement("div");
    card.className = "result-card";

    const compare = document.createElement("div");
    compare.className = "compare";

    const beforeImg = document.createElement("img");
    beforeImg.src = originalUrl;
    beforeImg.alt = "Original image";
    beforeImg.loading = "lazy";

    const afterImg = document.createElement("img");
    afterImg.src = resultUrl;
    afterImg.alt = "Eyes blurred result";
    afterImg.loading = "lazy";

    compare.append(beforeImg, afterImg);

    const info = document.createElement("div");
    info.className = "result-info";

    const filename = document.createElement("div");
    filename.className = "filename";
    filename.textContent = downloadName;

    const downloadBtn = document.createElement("a");
    downloadBtn.className = "download-btn";
    downloadBtn.href = resultUrl;
    downloadBtn.download = downloadName;
    downloadBtn.innerHTML = '<i class="fa-solid fa-download"></i> Download';

    info.append(filename, downloadBtn);
    card.append(compare, info);
    return card;
  }

  function getAll() {
    return results.slice();
  }

  function updateZipButtonState() {
    if (!DOM.downloadZip) return;
    DOM.downloadZip.disabled = results.length === 0;
  }

  return { addResult, clear, getAll };
})();

/* ==========================================================================
   13. DOWNLOAD MANAGER
   ========================================================================== */

const DownloadManager = (() => {
  function downloadBlob(blob, filename) {
    try {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      console.error("Download failed:", err);
      ToastManager.show("Download failed. Please try again.", "error");
    }
  }

  return { downloadBlob };
})();

/* ==========================================================================
   14. ZIP MANAGER
   ========================================================================== */

const ZipManager = (() => {
  async function downloadAllAsZip() {
    const results = ResultRenderer.getAll();

    if (results.length === 0) {
      ToastManager.show("No processed images to download yet.", "warning");
      return;
    }

    if (typeof window.JSZip === "undefined") {
      ToastManager.show("ZIP library failed to load.", "error");
      return;
    }

    try {
      LoaderManager.show();
      const zip = new window.JSZip();

      for (const result of results) {
        zip.file(result.name, result.blob);
      }

      const content = await zip.generateAsync({ type: "blob" }, (metadata) => {
        if (DOM.progressText) {
          DOM.progressText.textContent = `Building ZIP… ${Math.round(metadata.percent)}%`;
        }
      });

      DownloadManager.downloadBlob(content, "eyeblur-ai-results.zip");
      ToastManager.show("ZIP download started.", "success");
    } catch (err) {
      console.error("ZIP generation failed:", err);
      ToastManager.show("Could not build the ZIP file.", "error");
    } finally {
      LoaderManager.hide();
    }
  }

  return { downloadAllAsZip };
})();

/* ==========================================================================
   15. BACKGROUND ANIMATION (PARTICLE SYSTEM)
   ========================================================================== */

const BackgroundAnimation = (() => {
  let ctx = null;
  let canvas = null;
  let particles = [];
  let width = 0;
  let height = 0;
  let animationFrameId = null;
  const mouse = { x: -9999, y: -9999, active: false };

  class Particle {
    constructor() {
      this.reset();
    }

    reset() {
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      this.vx = (Math.random() - 0.5) * 0.3;
      this.vy = (Math.random() - 0.5) * 0.3;
      this.radius = Math.random() * 1.6 + 0.6;
    }

    step() {
      this.x += this.vx;
      this.y += this.vy;

      if (mouse.active) {
        const dx = this.x - mouse.x;
        const dy = this.y - mouse.y;
        const distance = Math.hypot(dx, dy);
        if (distance < CONFIG.PARTICLE_MOUSE_REPEL_RADIUS && distance > 0) {
          const force = (CONFIG.PARTICLE_MOUSE_REPEL_RADIUS - distance) / CONFIG.PARTICLE_MOUSE_REPEL_RADIUS;
          this.x += (dx / distance) * force * 1.6;
          this.y += (dy / distance) * force * 1.6;
        }
      }

      if (this.x < 0 || this.x > width) this.vx *= -1;
      if (this.y < 0 || this.y > height) this.vy *= -1;

      this.x = Utils.clamp(this.x, 0, width);
      this.y = Utils.clamp(this.y, 0, height);
    }

    draw() {
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0, 212, 255, 0.55)";
      ctx.fill();
    }
  }

  function resize() {
    if (!canvas) return;
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }

  function buildParticles() {
    const count = Utils.isMobileViewport()
      ? CONFIG.PARTICLE_COUNT_MOBILE
      : CONFIG.PARTICLE_COUNT_DESKTOP;
    particles = Array.from({ length: count }, () => new Particle());
  }

  function drawConnections() {
    for (let i = 0; i < particles.length; i += 1) {
      for (let j = i + 1; j < particles.length; j += 1) {
        const a = particles[i];
        const b = particles[j];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);

        if (distance < CONFIG.PARTICLE_LINK_DISTANCE) {
          const opacity = 1 - distance / CONFIG.PARTICLE_LINK_DISTANCE;
          ctx.beginPath();
          ctx.strokeStyle = `rgba(139, 92, 246, ${opacity * 0.35})`;
          ctx.lineWidth = 1;
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
  }

  function tick() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    particles.forEach((particle) => {
      particle.step();
      particle.draw();
    });

    drawConnections();
    animationFrameId = window.requestAnimationFrame(tick);
  }

  function start() {
    if (!DOM.particleCanvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    canvas = DOM.particleCanvas;
    ctx = canvas.getContext("2d");

    resize();
    buildParticles();
    tick();

    window.addEventListener("resize", Utils.debounce(() => {
      resize();
      buildParticles();
    }, 200), { passive: true });

    window.addEventListener("mousemove", Utils.rafThrottle((event) => {
      mouse.x = event.clientX;
      mouse.y = event.clientY;
      mouse.active = true;
    }), { passive: true });

    window.addEventListener("mouseleave", () => {
      mouse.active = false;
    }, { passive: true });
  }

  function stop() {
    if (animationFrameId) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = null;
    }
  }

  return { start, stop };
})();

/* ==========================================================================
   16. CURSOR GLOW
   ========================================================================== */

const CursorGlow = (() => {
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let rafId = null;

  function animate() {
    currentX += (targetX - currentX) * 0.15;
    currentY += (targetY - currentY) * 0.15;

    if (DOM.cursorGlow) {
      DOM.cursorGlow.style.transform = `translate3d(${currentX}px, ${currentY}px, 0)`;
    }

    rafId = window.requestAnimationFrame(animate);
  }

  function start() {
    if (!DOM.cursorGlow) return;
    if (Utils.isMobileViewport()) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    window.addEventListener("mousemove", (event) => {
      targetX = event.clientX;
      targetY = event.clientY;
    }, { passive: true });

    animate();
  }

  function stop() {
    if (rafId) window.cancelAnimationFrame(rafId);
  }

  return { start, stop };
})();

/* ==========================================================================
   17. EVENT LISTENERS (PROCESSING PIPELINE)
   ========================================================================== */

const ProcessingPipeline = (() => {
  function setProgress(current, total, label) {
    if (!DOM.progressFill || !DOM.progressText) return;
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    DOM.progressFill.style.width = `${percent}%`;
    DOM.progressText.textContent = label ?? `Processing ${current} of ${total}…`;
  }

  function showProgressSection() {
    DOM.progressSection?.classList.add("active");
    if (DOM.progressSection) DOM.progressSection.style.display = "flex";
  }

  function hideProgressSection() {
    if (DOM.progressSection) {
      window.setTimeout(() => {
        DOM.progressSection.style.display = "none";
      }, 600);
    }
  }

  async function processAll() {
    const images = PreviewManager.getAll();

    if (images.length === 0) {
      ToastManager.show("Add at least one image first.", "warning");
      return;
    }

    DOM.processButton.disabled = true;
    ResultRenderer.clear();
    showProgressSection();
    setProgress(0, images.length, "Preparing AI model…");

    try {
      await MediaPipeManager.init();
    } catch {
      hideProgressSection();
      DOM.processButton.disabled = false;
      return;
    }

    let processedCount = 0;
    let facesFoundTotal = 0;

    for (const entry of images) {
      processedCount += 1;
      setProgress(
        processedCount - 1,
        images.length,
        `Processing image ${processedCount} of ${images.length}…`
      );

      try {
        const outcome = await processSingleImage(entry);
        if (outcome.faceCount > 0) facesFoundTotal += outcome.faceCount;
      } catch (err) {
        console.error(`Failed to process ${entry.file.name}:`, err);
        ToastManager.show(`Could not process "${entry.file.name}".`, "error");
      }

      setProgress(processedCount, images.length);

      // Yield back to the browser so the UI never freezes.
      await Utils.yieldToBrowser();
    }

    setProgress(images.length, images.length, "Done!");
    hideProgressSection();
    DOM.processButton.disabled = false;

    if (facesFoundTotal === 0) {
      ToastManager.show("No faces were detected in the uploaded images.", "warning");
    } else {
      ToastManager.show("Processing complete. Eyes have been blurred.", "success");
    }
  }

  async function processSingleImage(entry) {
    const { file, url } = entry;

    const imageSource = await Utils.loadImageBitmap(file);
    const width = imageSource.width ?? imageSource.naturalWidth;
    const height = imageSource.height ?? imageSource.naturalHeight;

    let detection;
    try {
      detection = await MediaPipeManager.detect(imageSource);
    } catch (err) {
      console.error("Detection failed:", err);
      ToastManager.show(`Detection failed for "${file.name}".`, "error");
      detection = { faceLandmarks: [] };
    }

    const faceLandmarksList = detection?.faceLandmarks ?? [];
    const faceCount = faceLandmarksList.length;

    if (faceCount === 0) {
      ToastManager.show(`No face detected in "${file.name}". Skipping blur.`, "info");
    } else if (faceCount > 1) {
      ToastManager.show(`${faceCount} faces detected in "${file.name}".`, "info");
    }

    const regions = EyeDetection.extractEyeRegions(faceLandmarksList, width, height);
    const canvas = BlurEngine.applyEyeBlur(imageSource, width, height, regions);
    const blob = await BlurEngine.canvasToBlob(canvas);

    ResultRenderer.addResult(file.name, blob, url);

    if (imageSource.close) {
      imageSource.close();
    }

    return { faceCount };
  }

  return { processAll };
})();

/* ==========================================================================
   18. ACCESSIBILITY
   ========================================================================== */

const Accessibility = (() => {
  function bind() {
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        LoaderManager.forceHide();
      }
    });

    // Ensure all interactive result/preview buttons remain keyboard reachable.
    document.addEventListener("focusin", (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains("remove-btn")) {
        target.setAttribute("aria-current", "true");
      }
    });
  }

  return { bind };
})();

/* ==========================================================================
   19. ERROR HANDLING
   ========================================================================== */

const ErrorHandling = (() => {
  function bindGlobalHandlers() {
    window.addEventListener("error", (event) => {
      console.error("Unhandled error:", event.error ?? event.message);
    });

    window.addEventListener("unhandledrejection", (event) => {
      console.error("Unhandled promise rejection:", event.reason);
    });
  }

  function checkBrowserSupport() {
    const missing = [];

    if (!("createObjectURL" in URL)) missing.push("URL.createObjectURL");
    if (!document.createElement("canvas").getContext) missing.push("Canvas API");
    if (typeof window.fetch !== "function") missing.push("Fetch API");

    let webglSupported = true;
    try {
      const testCanvas = document.createElement("canvas");
      webglSupported = Boolean(
        testCanvas.getContext("webgl") || testCanvas.getContext("experimental-webgl")
      );
    } catch {
      webglSupported = false;
    }

    if (!webglSupported) {
      ToastManager.show(
        "Your browser has limited WebGL support. AI processing may be slower.",
        "warning"
      );
    }

    if (missing.length > 0) {
      ToastManager.show(
        "Your browser is missing required features. Please update or switch browsers.",
        "error"
      );
      return false;
    }

    return true;
  }

  return { bindGlobalHandlers, checkBrowserSupport };
})();

/* ==========================================================================
   20. INITIALIZATION
   ========================================================================== */

const App = (() => {
  function bindProcessAndDownload() {
    DOM.processButton?.addEventListener("click", () => {
      ProcessingPipeline.processAll();
    });

    DOM.downloadZip?.addEventListener("click", () => {
      ZipManager.downloadAllAsZip();
    });
  }

  function bindNavbarScrollEffect() {
    if (!DOM.navbar) return;
    window.addEventListener(
      "scroll",
      Utils.rafThrottle(() => {
        if (window.scrollY > 12) {
          DOM.navbar.style.background = "rgba(10, 10, 13, 0.75)";
        } else {
          DOM.navbar.style.background = "";
        }
      }),
      { passive: true }
    );
  }

  function init() {
    ErrorHandling.bindGlobalHandlers();
    ErrorHandling.checkBrowserSupport();

    UploadManager.bindEvents();
    PreviewManager.updateProcessButtonState();
    bindProcessAndDownload();
    bindNavbarScrollEffect();

    BackgroundAnimation.start();
    CursorGlow.start();
    Accessibility.bind();

    if (DOM.processButton) DOM.processButton.disabled = true;
    if (DOM.downloadZip) DOM.downloadZip.disabled = true;
    if (DOM.progressSection) DOM.progressSection.style.display = "none";

    LoaderManager.forceHide();
  }

  return { init };
})();

// face-api.js wrapper + auto-capture
const FACE_MODEL_URL = "https://justadudewhohacks.github.io/face-api.js/models";
let faceReady = false;

async function loadFaceModels() {
  if (faceReady) return;
  await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_MODEL_URL);
  await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_MODEL_URL);
  await faceapi.nets.faceRecognitionNet.loadFromUri(FACE_MODEL_URL);
  faceReady = true;
}

async function startCamera(videoEl) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: { ideal: 480 }, height: { ideal: 360 } },
    audio: false,
  });
  videoEl.srcObject = stream;
  await videoEl.play();
  return stream;
}

function stopCamera(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

function captureFrame(videoEl) {
  const canvas = document.createElement("canvas");
  canvas.width = videoEl.videoWidth;
  canvas.height = videoEl.videoHeight;
  canvas.getContext("2d").drawImage(videoEl, 0, 0);
  return canvas;
}

async function getFaceEmbedding(canvasOrImg) {
  const detection = await faceapi
    .detectSingleFace(canvasOrImg, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
    .withFaceLandmarks()
    .withFaceDescriptor();
  if (!detection) return null;
  return Array.from(detection.descriptor);
}

function canvasToBase64(canvas, quality = 0.8) {
  return canvas.toDataURL("image/jpeg", quality);
}

/**
 * Auto-capture flow:
 * - Continuously detect face
 * - Draw bbox overlay on the given canvas element
 * - When face is stably detected N frames with size > minBoxRatio, start countdown
 * - At countdown=0, fire onCapture(canvas, embedding)
 *
 * Options:
 *  video: video element
 *  overlay: canvas element overlaid on video (same CSS size as video)
 *  onStatus(text): update UI status
 *  onCountdown(n): fire per second (n=3,2,1,0)
 *  onCapture({canvas, embedding, base64}): fire when captured
 */
function startAutoCapture({ video, overlay, onStatus, onCountdown, onCapture, minBoxRatio = 0.2 }) {
  const detectorOpts = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  let stableCount = 0;
  const STABLE_NEEDED = 5;
  let countdownTimer = null;
  let countdownValue = 0;
  let running = true;
  let captured = false;

  function drawBox(box, videoW, videoH) {
    const ctx = overlay.getContext("2d");
    overlay.width = videoW;
    overlay.height = videoH;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!box) return;
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 4;
    ctx.strokeRect(box.x, box.y, box.width, box.height);
  }

  function startCountdown() {
    if (countdownTimer) return;
    countdownValue = 3;
    onCountdown?.(3);
    countdownTimer = setInterval(() => {
      countdownValue--;
      onCountdown?.(countdownValue);
      if (countdownValue <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        capture();
      }
    }, 800);
  }

  function cancelCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      onCountdown?.(null);
    }
  }

  async function capture() {
    if (captured) return;
    captured = true;
    running = false;
    onStatus?.("解析中…");
    const canvas = captureFrame(video);
    const embedding = await getFaceEmbedding(canvas);
    if (!embedding) {
      captured = false;
      running = true;
      stableCount = 0;
      onStatus?.("顔がブレました、もう一度");
      loop();
      return;
    }
    onCapture?.({ canvas, embedding, base64: canvasToBase64(canvas) });
  }

  async function loop() {
    if (!running) return;
    try {
      const detection = await faceapi.detectSingleFace(video, detectorOpts);
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (detection) {
        const box = detection.box;
        drawBox(box, vw, vh);
        const ratio = Math.min(box.width / vw, box.height / vh);
        if (ratio > minBoxRatio) {
          stableCount++;
          if (stableCount >= STABLE_NEEDED) {
            onStatus?.("顔を検出！撮影します");
            startCountdown();
          } else {
            onStatus?.(`顔検出中… (${stableCount}/${STABLE_NEEDED})`);
          }
        } else {
          stableCount = Math.max(0, stableCount - 1);
          cancelCountdown();
          onStatus?.("もう少し近づいてください");
        }
      } else {
        drawBox(null);
        stableCount = 0;
        cancelCountdown();
        onStatus?.("顔を映してください");
      }
    } catch (e) {
      console.error(e);
    }
    if (running) setTimeout(loop, 200);
  }

  loop();

  return {
    stop: () => {
      running = false;
      cancelCountdown();
    },
  };
}

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.WalkImport = api;
})(globalThis, function () {
  "use strict";

  function nonnegative(value, integer = false) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || (integer && !Number.isSafeInteger(number))) {
      throw new Error("散歩または運動の入力値を確認してください");
    }
    return number;
  }

  function questText(date, distance, squat, plank) {
    return JSON.stringify({
      type: "walk-quest-daily-v1", date, walkKm: nonnegative(distance),
      squats: nonnegative(squat, true), plankSeconds: nonnegative(plank, true)
    });
  }

  function addWalk(existing, added) {
    if (Object.values(added).some(value => value === "")) throw new Error("時間・距離・歩数をすべて確認して入力してください");
    const time = (values) => {
      const seconds = nonnegative(values.walkSeconds, true);
      if (seconds > 59) throw new Error("時間・秒は0〜59で入力してください");
      return nonnegative(values.walkMinutes, true) * 60 + seconds;
    };
    const seconds = nonnegative(time(existing) + time(added), true);
    const steps = nonnegative(nonnegative(existing.walkSteps, true) + nonnegative(added.walkSteps, true), true);
    const distances = [existing.distance, added.distance].map(value => nonnegative(value));
    // Use the operands' decimal precision so sums such as 2.06 + 1.5 stay 3.56.
    const places = Math.max(...distances.map(value => {
      const [digits, exponent = "0"] = String(value).split("e");
      return (digits.split(".")[1]?.length || 0) - Number(exponent);
    }), 0);
    const distance = nonnegative(distances[0] + distances[1]);
    return {
      walkMinutes: String(Math.floor(seconds / 60)), walkSeconds: String(seconds % 60),
      distance: places <= 100 ? String(Number(distance.toFixed(places))) : String(distance),
      walkSteps: String(steps)
    };
  }

  function parseReadings({ date, duration, distance, steps }, validDate) {
    const stamp = /^(\d{4})\s*\/\s*(\d{1,2})\s*\/\s*(\d{1,2})\s+\d{1,2}:\d{2}$/.exec(date.trim());
    const dateKey = stamp ? [stamp[1], stamp[2].padStart(2, "0"), stamp[3].padStart(2, "0")].join("-") : "";
    const time = /^(\d{2}):([0-5]\d):([0-5]\d)$/.exec(duration.trim());
    return {
      date: dateKey && validDate(dateKey) ? dateKey : "",
      walkMinutes: time ? String(Number(time[1]) * 60 + Number(time[2])) : "",
      walkSeconds: time ? String(Number(time[3])) : "",
      distance: /^\d+\.\d+$/.test(distance.trim()) ? distance.trim() : "",
      walkSteps: /^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(steps.trim()) ? steps.trim().replace(/,/g, "") : ""
    };
  }

  // Regions are based on the supplied dark Mi Fitness walking detail screenshot.
  // The map, account identifier, pace and heart rate are outside these crops.
  const regions = {
    title: [39, 675, 125, 35],
    date: [394, 782, 154, 34],
    duration: [39, 870, 151, 45],
    distance: [38, 741, 154, 76],
    steps: [389, 969, 104, 45]
  };

  function crop(image, region) {
    const [x, y, width, height] = region;
    const canvas = document.createElement("canvas");
    canvas.width = width * 3 + 24;
    canvas.height = height * 3 + 24;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.fillStyle = "#202020";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, x * image.naturalWidth / 590, y * image.naturalHeight / 1280,
      width * image.naturalWidth / 590, height * image.naturalHeight / 1280, 12, 12, width * 3, height * 3);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < pixels.data.length; index += 4) {
      const gray = (pixels.data[index] + pixels.data[index + 1] + pixels.data[index + 2]) / 3;
      pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = 255 - (gray - 34) * 4;
    }
    context.putImageData(pixels, 0, 0);
    return canvas;
  }

  async function readImage(file, validDate, signal) {
    if (file.size > 20 * 1024 * 1024) throw new Error("20MB以下の画像を選んでください");
    const source = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = source;
      await image.decode();
      if (Math.abs(image.naturalWidth / image.naturalHeight - 590 / 1280) > 0.025) {
        throw new Error("Mi Fitnessのウォーキング詳細画面全体の画像を選んでください");
      }
      const base = new URL("vendor/walk-ocr/", document.baseURI);
      const { default: tesseract } = await import(new URL("tesseract.esm.min.js", base).href);
      signal.throwIfAborted();
      let worker;
      let rejectRead;
      const interrupted = new Promise((_, reject) => { rejectRead = reject; });
      const abort = () => rejectRead(signal.reason);
      const timeout = setTimeout(() => rejectRead(new Error("読み取りに時間がかかっています。画像を選び直すか、各項目を手入力してください")), 45000);
      signal.addEventListener("abort", abort, { once: true });
      let finished = false;
      const recognizeFields = async () => {
        worker = await tesseract.createWorker("eng", 1, {
          workerPath: new URL("worker.min.js", base).href, workerBlobURL: false,
          corePath: new URL("tesseract-core-lstm.wasm.js", base).href, langPath: base.href,
          cacheMethod: "none", errorHandler: rejectRead
        });
        if (finished) {
          await worker.terminate();
          return;
        }
        await worker.setParameters({ tessedit_pageseg_mode: "7" });
        const recognize = async name => (await worker.recognize(crop(image, regions[name]))).data.text;
        if (!/\bmi\s*fitness\b/i.test(await recognize("title"))) {
          throw new Error("対応するMi Fitnessの詳細画面を確認できませんでした。各項目を手入力できます");
        }
        await worker.setParameters({ tessedit_char_whitelist: "0123456789/:., " });
        const readings = {};
        for (const name of ["date", "duration", "distance", "steps"]) readings[name] = await recognize(name);
        return parseReadings(readings, validDate);
      };
      try {
        return await Promise.race([recognizeFields(), interrupted]);
      } finally {
        finished = true;
        clearTimeout(timeout);
        signal.removeEventListener("abort", abort);
        await worker?.terminate();
      }
    } finally {
      URL.revokeObjectURL(source);
    }
  }

  return { questText, addWalk, parseReadings, readImage };
});

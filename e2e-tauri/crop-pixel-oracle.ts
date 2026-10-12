/** Serializable renderer oracle used by the real native crop suite. */
export async function compareCropPixels(original: string, saved: string, padded: boolean, measureEdges: boolean, rectangle: number[], done: (result: unknown) => void) {
    try {
      const load = async (url: string) => { const image = new Image(); image.src = url; await image.decode(); return image; };
      const [source, result] = await Promise.all([load(original), load(saved)]);
      const canvas = document.createElement("canvas");
      canvas.width = result.naturalWidth; canvas.height = result.naturalHeight;
      const context = canvas.getContext("2d")!;
      if (padded) context.drawImage(source, 16, 16, 224, 224, 16, 16, 224, 224);
      else context.drawImage(source, rectangle[0], rectangle[1], rectangle[2], rectangle[3], 0, 0, rectangle[2], rectangle[3]);
      const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
      context.clearRect(0, 0, canvas.width, canvas.height); context.drawImage(result, 0, 0);
      const actual = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let maximumError = 0;
      // JPEG edges may change when the selected area is encoded as new blocks;
      // compare interior samples there, every pixel in the lossless formats.
      for (let i = 0; i < actual.length; i++) maximumError = Math.max(maximumError, Math.abs(actual[i] - expected[i]));
      const insetX = Math.min(40, Math.floor(canvas.width / 4));
      const insetY = Math.min(40, Math.floor(canvas.height / 4));
      const samples = [[insetX, insetY], [canvas.width - 1 - insetX, insetY], [insetX, canvas.height - 1 - insetY], [canvas.width - 1 - insetX, canvas.height - 1 - insetY]];
      let interiorError = 0;
      for (const [x, y] of samples) for (let c = 0; c < 3; c++) {
        const index = (y * canvas.width + x) * 4 + c;
        interiorError = Math.max(interiorError, Math.abs(actual[index] - expected[index]));
      }
      let edgeDisplacement = 0;
      if (measureEdges) {
        // Track the four actual quadrant boundaries, away from the center.
        // A missing transition is a failed oracle, never a matching sentinel.
        const transition = (data: Uint8ClampedArray, horizontal: boolean, fixed: number, positive: number, negative: number) => {
          const length = horizontal ? canvas.width : canvas.height;
          for (let p = 0; p < length; p++) {
            const i = (horizontal ? fixed * canvas.width + p : p * canvas.width + fixed) * 4;
            if (data[i + positive] > data[i + negative]) {
              if (p === 0 || p === length - 1) throw new Error("JPEG fixture has no interior color transition");
              return p;
            }
          }
          throw new Error("JPEG fixture has no color transition");
        };
        for (const [horizontal, fixed, positive, negative] of [
          [true, Math.floor(canvas.height / 4), 1, 0],
          [true, Math.floor(canvas.height * 3 / 4), 0, 2],
          [false, Math.floor(canvas.width / 4), 2, 0],
          [false, Math.floor(canvas.width * 3 / 4), 0, 1],
        ] as const) {
          edgeDisplacement = Math.max(edgeDisplacement, Math.abs(transition(actual, horizontal, fixed, positive, negative) - transition(expected, horizontal, fixed, positive, negative)));
        }
      }
      done({ size: [result.naturalWidth, result.naturalHeight], maximumError, interiorError,
        edgeDisplacement,
        cornerAlpha: actual[3], centerAlpha: actual[(Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4 + 3] });
    } catch (error) { done({ error: String(error) }); }
  }

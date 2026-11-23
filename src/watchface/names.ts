/**
 * The image names Tartan's face layout uses (src/watchface/layout.ts), apart so the drawing
 * code can name its images without loading the layout. Any names do: the layout hashes and lays
 * out whatever it's given.
 */
export const IMAGE_NAMES = {
  preview: "tt_pvw",
  background: "tt_wf_bg",
  hour: "tt_hour",
  minute: "tt_minute",
  capUnder: "tt_pin1",
  capOver: "tt_pin2",
  /** Seconds hands: slot 0 is the default, then the seven options in order. */
  seconds: [1, 2, 3, 4, 5, 6, 7].map((i) => `tt_second_${i}`),
};

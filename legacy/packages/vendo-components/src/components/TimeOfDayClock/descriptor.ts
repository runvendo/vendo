import { z } from "zod";
import { prewired } from "../../descriptor.js";

export const timeOfDayClockSchema = z.object({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  /** Start of the highlighted "asleep" band, in hours (0-24). Default 0. */
  lateNightStart: z.number().optional(),
  /** End of the highlighted "asleep" band, in hours (0-24). Default 5. */
  lateNightEnd: z.number().optional(),
  /** Each spending event placed on the dial. */
  points: z.array(
    z.object({
      /** Hour of day, 0-24 (fractional for minutes, e.g. 1.23 = 1:14am). */
      hour: z.number(),
      /** Amount in dollars (positive). Drives the dot size. */
      amount: z.number(),
      /** Short label, e.g. "DoorDash". Shown for the highlighted point. */
      label: z.string().optional(),
      /** Mark the standout charge — drawn larger, accented, with a callout. */
      highlight: z.boolean().optional(),
    }),
  ),
});

export const timeOfDayClockDescriptor = prewired(
  "TimeOfDayClock",
  "A 24-hour radial clock that plots spending by time of day — midnight at the top, " +
    "a highlighted 'asleep' band over the late-night hours, and each transaction as a " +
    "dot placed at its hour and sized by amount. Mark the standout charge with " +
    "highlight:true and a label so it gets a callout. Use this for 'when did I spend' / " +
    "'what did I buy when I should've been asleep' time-of-day questions.",
  timeOfDayClockSchema,
);

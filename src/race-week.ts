/**
 * Race week: the last seven days before your race, on Today. What today is for (taper, sharpen,
 * rest, race), how to pace it evenly from your target (or predicted) time, how to fuel it for
 * its length, and a short checklist.
 */
import type { Split } from "./race-pace.ts";

export interface RaceIn {
  name?: string;
  distance_km: number;
  date?: string;
  target_s?: number;
  predicted_s?: number;
  days_to_go?: number;
}

export interface RaceWeek {
  days_to_go: number;
  focus: { title: string; text: string };
  pacing: { time_s: number; pace_s: number; from: "target" | "predicted"; checkpoints: Array<{ at_km: number; time_s: number }>; start: string } | null;
  fuel: { before: string[]; during: string[] };
  checklist: string[];
}

const FOCUS: Array<[number, string, string]> = [
  [0, "Race day", "Breakfast you know, about three hours before. Warm up for 10 to 15 minutes with a few strides. Start at goal pace, not faster: the first kilometre always feels easy."],
  [1, "Rest, or a shake-out", "Rest, or 15 to 20 minutes very easy with four short strides. Lay out your kit, check the start time and how you'll get there, and eat carbohydrate at every meal."],
  [3, "Short and sharp", "Easy running only, with a few strides or race-pace minutes to stay sharp. Nothing new: shoes, food and kit you know."],
  [7, "Taper", "Less volume, a little intensity kept. The work is done: the fitness is in the bank and the tiredness is leaving. Sleep is training this week."],
];

/** The race week, or null when the race is more than a week away or past. */
export function raceWeek(r: RaceIn): RaceWeek | null {
  const d = r.days_to_go;
  if (d === undefined || d < 0 || d > 7) return null;
  const [, title, text] = FOCUS.find(([upTo]) => d <= upTo)!;
  const time = r.target_s ?? r.predicted_s ?? null;
  const km = r.distance_km;
  const pace = time ? time / km : null;
  const marks = [5, 10, 21.0975, 30, 35, 40].filter((m) => m < km - 0.5);
  const half = km / 2;
  const pacing =
    time && pace
      ? {
          time_s: time,
          pace_s: pace,
          from: (r.target_s ? "target" : "predicted") as "target" | "predicted",
          checkpoints: [...new Set([...marks, half])].sort((a, b) => a - b).map((m) => ({ at_km: Math.round(m * 100) / 100, time_s: Math.round(pace * m) })),
          start: km <= 10 ? "Settle into goal pace by the end of the first kilometre." : "First two kilometres 5 seconds per km slower than goal pace, then settle in.",
        }
      : null;
  // Fuel by how long it takes: none during a short race, carbohydrate and drink for a long one.
  const minutes = time ? time / 60 : km * 6;
  const fuel =
    minutes < 75
      ? { before: ["A normal, carbohydrate-rich dinner the night before.", "Breakfast 2 to 3 hours before; a small snack an hour out if you like."], during: ["Nothing needed during the race; water at a station if it's warm."] }
      : {
          before: [
            minutes >= 90 ? "For two days before: carbohydrate at every meal, about 8 to 10 g per kg of body weight a day." : "Extra carbohydrate the day before.",
            "Breakfast you know, 3 hours before: mostly carbohydrate, little fibre and fat.",
          ],
          during: [
            `About ${minutes >= 150 ? "60 to 90" : "30 to 60"} g of carbohydrate an hour: a gel every ${minutes >= 150 ? 30 : 40} minutes from the ${minutes >= 150 ? "30th" : "40th"}.`,
            "Sips at the drink stations, 400 to 600 ml an hour, more in the heat.",
            "Only gels and drinks you've tried in training.",
          ],
        };
  const checklist = [
    "Shoes and kit worn in on a long run",
    "Bib, pins or race belt, and the start time",
    "Watch charged, pacing workout on it",
    ...(minutes >= 75 ? ["Gels counted and packed"] : []),
    "Travel to the start, with time to spare",
  ];
  return { days_to_go: d, focus: { title, text }, pacing, fuel, checklist };
}

/** Even splits for a pacing workout on the watch: a kilometre each, the last one what's left. */
export function evenSplits(distance_km: number, time_s: number): Split[] {
  const pace = time_s / distance_km;
  const out: Split[] = [];
  let done = 0;
  for (let k = 1; done < distance_km - 1e-6; k++) {
    const len = Math.min(1, distance_km - done);
    done += len;
    out.push({ km: k, distance_m: Math.round(len * 1000), time_s: pace * len, pace_s: pace, cumulative_s: pace * done, climb_m: 0, descent_m: 0 });
  }
  return out;
}

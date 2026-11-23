/**
 * Strength and mobility for runners: the exercises the coach can put in a session, each with the
 * muscles it works (for the muscle map), a default prescription, three form cues and why it helps
 * a runner. Every one has a looping figure (web/lib/figure.ts) under the same id.
 */

export const MUSCLES = [
  "traps", "delts", "chest", "biceps", "triceps", "forearms", "lats", "upper_back", "lower_back",
  "abs", "obliques", "hip_flexors", "glutes", "glute_med", "adductors", "quads", "hamstrings", "calves", "tibialis",
] as const;
export type Muscle = (typeof MUSCLES)[number];

export const MUSCLE_NAME: Record<Muscle, string> = {
  traps: "Traps", delts: "Shoulders", chest: "Chest", biceps: "Biceps", triceps: "Triceps", forearms: "Forearms",
  lats: "Lats", upper_back: "Upper back", lower_back: "Lower back", abs: "Abs", obliques: "Obliques",
  hip_flexors: "Hip flexors", glutes: "Glutes", glute_med: "Side glutes", adductors: "Inner thighs", quads: "Quads",
  hamstrings: "Hamstrings", calves: "Calves", tibialis: "Shins",
};

export interface Dose {
  sets: number;
  reps?: number;
  seconds?: number;
  /** Reps or seconds are per side. */
  each_side?: boolean;
}

export interface Exercise {
  id: string;
  name: string;
  kind: "strength" | "core" | "power" | "mobility";
  primary: Muscle[];
  secondary: Muscle[];
  dose: Dose;
  equipment?: string;
  cues: [string, string, string];
  why: string;
}

const E = (x: Exercise) => x;

export const EXERCISES: Exercise[] = [
  E({ id: "squat", name: "Squat", kind: "strength", primary: ["quads", "glutes"], secondary: ["adductors", "lower_back", "calves"], dose: { sets: 3, reps: 12 },
    cues: ["Feet shoulder-width, toes slightly out", "Sit back and down, chest up", "Knees track over your toes"], why: "Strong quads and glutes absorb each landing, so your knees don't have to." }),
  E({ id: "goblet_squat", name: "Goblet squat", kind: "strength", primary: ["quads", "glutes"], secondary: ["adductors", "abs", "upper_back"], dose: { sets: 3, reps: 10 }, equipment: "Dumbbell or kettlebell",
    cues: ["Hold the weight at your chest", "Elbows inside the knees at the bottom", "Drive up through the whole foot"], why: "Loaded squats build the strength that holds your form late in a race." }),
  E({ id: "reverse_lunge", name: "Reverse lunge", kind: "strength", primary: ["quads", "glutes"], secondary: ["hamstrings", "adductors", "glute_med"], dose: { sets: 3, reps: 10, each_side: true },
    cues: ["Step back, both knees to 90°", "Front shin stays upright", "Push through the front heel to stand"], why: "Running is one leg at a time: this trains each side on its own." }),
  E({ id: "split_squat", name: "Bulgarian split squat", kind: "strength", primary: ["quads", "glutes"], secondary: ["hamstrings", "adductors", "glute_med"], dose: { sets: 3, reps: 8, each_side: true }, equipment: "Bench or step",
    cues: ["Back foot on the bench, laces down", "Lower straight down, torso tall", "Front knee over the middle of the foot"], why: "The best single-leg strength builder for hills and the final kilometres." }),
  E({ id: "single_leg_rdl", name: "Single-leg deadlift", kind: "strength", primary: ["hamstrings", "glutes"], secondary: ["glute_med", "lower_back", "calves"], dose: { sets: 3, reps: 8, each_side: true },
    cues: ["Hinge at the hip, back flat", "Free leg reaches back in line with your body", "Hips stay square to the floor"], why: "Hamstring strength and balance on one leg: fewer pulls, steadier stride." }),
  E({ id: "rdl", name: "Romanian deadlift", kind: "strength", primary: ["hamstrings", "glutes"], secondary: ["lower_back", "forearms", "upper_back"], dose: { sets: 3, reps: 10 }, equipment: "Dumbbells or a bar",
    cues: ["Soft knees, push the hips back", "Weights slide down close to the legs", "Stand tall by squeezing the glutes"], why: "Strong posterior chain: more push-off, less load on the lower back." }),
  E({ id: "glute_bridge", name: "Glute bridge", kind: "strength", primary: ["glutes"], secondary: ["hamstrings", "lower_back", "abs"], dose: { sets: 3, reps: 15 },
    cues: ["Feet flat, knees bent", "Lift the hips until knees, hips and shoulders line up", "Squeeze the glutes at the top for a second"], why: "Wakes up the glutes so they, not your lower back, drive your stride." }),
  E({ id: "single_leg_bridge", name: "Single-leg bridge", kind: "strength", primary: ["glutes", "hamstrings"], secondary: ["glute_med", "lower_back", "abs"], dose: { sets: 3, reps: 10, each_side: true },
    cues: ["One foot down, the other leg straight", "Hips stay level as you lift", "Pause at the top"], why: "Each glute on its own, as in running: evens out a weaker side." }),
  E({ id: "calf_raise", name: "Calf raise", kind: "strength", primary: ["calves"], secondary: ["tibialis"], dose: { sets: 3, reps: 15 },
    cues: ["Rise onto the balls of your feet", "Pause at the top", "Lower slowly, three seconds"], why: "Your calves take several times your body weight with every step." }),
  E({ id: "single_leg_calf_raise", name: "Single-leg calf raise", kind: "strength", primary: ["calves"], secondary: ["tibialis", "glute_med"], dose: { sets: 3, reps: 12, each_side: true },
    cues: ["Stand on one foot, a hand on the wall", "Straight knee, all the way up", "Three seconds down"], why: "Protects the Achilles and calves, the most common runner niggles." }),
  E({ id: "plank", name: "Plank", kind: "core", primary: ["abs"], secondary: ["obliques", "delts", "glutes", "quads"], dose: { sets: 3, seconds: 40 },
    cues: ["Elbows under the shoulders", "One straight line from head to heels", "Breathe, don't hold your breath"], why: "A stiff trunk passes force from your legs instead of leaking it." }),
  E({ id: "push_up", name: "Push-up", kind: "strength", primary: ["chest", "triceps"], secondary: ["delts", "abs"], dose: { sets: 3, reps: 10 },
    cues: ["Hands just wider than the shoulders", "Body in one line, core tight", "Chest close to the floor, then press"], why: "Upper-body strength keeps your arm drive and posture late in long runs." }),
  E({ id: "dead_bug", name: "Dead bug", kind: "core", primary: ["abs"], secondary: ["obliques", "hip_flexors"], dose: { sets: 3, reps: 8, each_side: true },
    cues: ["Lower back pressed into the floor", "Reach the opposite arm and leg away", "Move slowly, breathe out as you reach"], why: "Teaches your core to stay still while arms and legs move: running." }),
  E({ id: "bird_dog", name: "Bird dog", kind: "core", primary: ["lower_back", "glutes"], secondary: ["abs", "delts", "hamstrings"], dose: { sets: 3, reps: 8, each_side: true },
    cues: ["Hands under shoulders, knees under hips", "Reach the opposite arm and leg long", "Keep the hips level, no twisting"], why: "Back and glute control for a steady pelvis on every stride." }),
  E({ id: "jump_squat", name: "Jump squat", kind: "power", primary: ["quads", "glutes", "calves"], secondary: ["hamstrings"], dose: { sets: 3, reps: 8 },
    cues: ["Quarter squat, then jump tall", "Land softly through the balls of the feet", "Reset before the next one"], why: "Springiness: more speed for the same effort." }),
  E({ id: "pogo_hops", name: "Pogo hops", kind: "power", primary: ["calves"], secondary: ["tibialis", "quads"], dose: { sets: 3, seconds: 20 },
    cues: ["Small, quick hops on the balls of the feet", "Knees almost straight, stiff ankles", "Quiet landings"], why: "Trains the ankle spring that makes running economical." }),
  E({ id: "hip_flexor_stretch", name: "Kneeling hip flexor stretch", kind: "mobility", primary: ["hip_flexors"], secondary: ["quads"], dose: { sets: 2, seconds: 40, each_side: true },
    cues: ["Kneel in a lunge, back knee down", "Tuck the pelvis, squeeze the back glute", "Shift forward until the front of the hip stretches"], why: "Opens hips that sitting tightens, for a longer, easier stride." }),

  // The gym classics: loaded lifts and staples, for athletes with the kit (the coach checks first).
  E({ id: "back_squat", name: "Back squat", kind: "strength", primary: ["quads", "glutes"], secondary: ["adductors", "lower_back", "abs"], dose: { sets: 4, reps: 6 }, equipment: "Barbell and rack",
    cues: ["Bar on your upper back, hands just outside the shoulders", "Brace, then sit down between your hips", "Drive up, chest and hips rising together"], why: "The heaviest leg strength you can build: more push in every stride and sturdier knees." }),
  E({ id: "deadlift", name: "Deadlift", kind: "strength", primary: ["hamstrings", "glutes", "lower_back"], secondary: ["quads", "traps", "forearms", "upper_back"], dose: { sets: 4, reps: 5 }, equipment: "Barbell",
    cues: ["Bar over mid-foot, shins close to it", "Flat back, push the floor away", "Hips and shoulders rise together; stand tall"], why: "Strengthens the whole back of the body that holds your posture late in a run." }),
  E({ id: "bench_press", name: "Bench press", kind: "strength", primary: ["chest", "triceps"], secondary: ["delts"], dose: { sets: 4, reps: 8 }, equipment: "Barbell and bench",
    cues: ["Eyes under the bar, feet planted", "Lower to mid-chest, elbows at about 45°", "Press up and slightly back"], why: "Upper-body strength for a strong arm drive and a balanced body." }),
  E({ id: "overhead_press", name: "Overhead press", kind: "strength", primary: ["delts", "triceps"], secondary: ["traps", "upper_back", "abs"], dose: { sets: 4, reps: 6 }, equipment: "Barbell",
    cues: ["Bar on your collarbones, grip just outside the shoulders", "Squeeze your glutes, press straight up", "Head through at the top"], why: "Strong shoulders on a stable trunk: good posture when you tire." }),
  E({ id: "barbell_row", name: "Bent-over row", kind: "strength", primary: ["lats", "upper_back"], secondary: ["biceps", "lower_back", "forearms"], dose: { sets: 4, reps: 8 }, equipment: "Barbell",
    cues: ["Hinge to about 45°, back flat", "Pull the bar to your lower ribs", "Lower it under control"], why: "Pulling strength that keeps your upper back from rounding late in a race." }),
  E({ id: "pull_up", name: "Pull-up", kind: "strength", primary: ["lats", "biceps"], secondary: ["upper_back", "forearms", "abs"], dose: { sets: 4, reps: 5 }, equipment: "Pull-up bar",
    cues: ["Hang on straight arms, hands a little wider than the shoulders", "Pull your chest to the bar", "Lower all the way, slowly"], why: "The best upper-body pull there is: a strong back and arms that hold your form." }),
  E({ id: "dumbbell_curl", name: "Biceps curl", kind: "strength", primary: ["biceps"], secondary: ["forearms"], dose: { sets: 3, reps: 12 }, equipment: "Dumbbells",
    cues: ["Elbows by your sides", "Curl up, palms to your shoulders", "Lower slowly"], why: "Arm strength for a strong swing on hills and sprints." }),
  E({ id: "lateral_raise", name: "Lateral raise", kind: "strength", primary: ["delts"], secondary: ["traps"], dose: { sets: 3, reps: 12 }, equipment: "Dumbbells",
    cues: ["A little bend in the elbows", "Raise out to shoulder height", "Lead with the elbows; lower slowly"], why: "Healthy, strong shoulders that carry your arm swing." }),
  E({ id: "hip_thrust", name: "Hip thrust", kind: "strength", primary: ["glutes"], secondary: ["hamstrings", "quads", "abs"], dose: { sets: 4, reps: 10 }, equipment: "Barbell and bench",
    cues: ["Upper back on the bench, bar over your hips", "Drive through your heels to a straight line", "Ribs down; squeeze at the top"], why: "Glute power for hills and the last kilometres." }),
  E({ id: "kettlebell_swing", name: "Kettlebell swing", kind: "power", primary: ["glutes", "hamstrings"], secondary: ["lower_back", "delts", "forearms", "abs"], dose: { sets: 3, reps: 15 }, equipment: "Kettlebell",
    cues: ["Hike the bell back between your legs", "Snap your hips through", "Let it float to chest height"], why: "Explosive hips: a faster, springier stride." }),
  E({ id: "step_up", name: "Step-up", kind: "strength", primary: ["quads", "glutes"], secondary: ["hamstrings", "calves", "glute_med"], dose: { sets: 3, reps: 10, each_side: true }, equipment: "Box or bench",
    cues: ["Whole foot on the box", "Drive up through the top leg, not the back one", "Step down slowly"], why: "Single-leg strength the way running uses it: one leg lifting you up." }),
  E({ id: "side_plank", name: "Side plank", kind: "core", primary: ["obliques"], secondary: ["glute_med", "abs", "delts"], dose: { sets: 3, seconds: 30, each_side: true },
    cues: ["Elbow under the shoulder", "Hips up, a straight line head to feet", "Breathe; don't let the hips sag"], why: "Stops the hip dropping on every stride." }),
  E({ id: "bench_dip", name: "Bench dip", kind: "strength", primary: ["triceps"], secondary: ["chest", "delts"], dose: { sets: 3, reps: 12 }, equipment: "Bench or chair",
    cues: ["Hands on the edge behind you, fingers forward", "Lower until your elbows reach 90°", "Press back up, shoulders down"], why: "Arm and shoulder strength with nothing but a bench." }),
  E({ id: "mountain_climber", name: "Mountain climbers", kind: "power", primary: ["abs", "hip_flexors"], secondary: ["delts", "quads", "obliques"], dose: { sets: 3, seconds: 30 },
    cues: ["Hands under the shoulders, body long", "Drive the knees to your chest in turn", "Keep the hips level"], why: "Core and quick knee drive, with your heart rate up." }),
  E({ id: "crunch", name: "Crunch", kind: "core", primary: ["abs"], secondary: ["obliques"], dose: { sets: 3, reps: 15 },
    cues: ["Knees bent, feet flat", "Curl your shoulders off the floor", "Lower slowly; don't pull on your neck"], why: "A strong front of the trunk to hold your posture." }),
];

const BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));
export const EXERCISE_IDS = EXERCISES.map((e) => e.id) as [string, ...string[]];
export const exercise = (id: string): Exercise | undefined => BY_ID.get(id);

export interface PlannedExercise extends Dose {
  id: string;
}

/** A runner's routine for a session that names no exercises, sized to its length. */
export function defaultRoutine(minutes = 30): PlannedExercise[] {
  const order = ["squat", "reverse_lunge", "single_leg_rdl", "glute_bridge", "calf_raise", "plank", "dead_bug", "bird_dog"];
  const n = minutes <= 20 ? 4 : minutes <= 30 ? 6 : 8;
  return order.slice(0, n).map((id) => ({ id, ...BY_ID.get(id)!.dose }));
}

/** The session's exercises with their library entries (unknown ids left out). */
export function routineOf(list: PlannedExercise[] | undefined, minutes?: number): Array<{ ex: Exercise; dose: Dose }> {
  const items = list?.length ? list : defaultRoutine(minutes);
  return items.flatMap((p) => {
    const ex = BY_ID.get(p.id);
    return ex ? [{ ex, dose: { sets: p.sets ?? ex.dose.sets, reps: p.reps ?? (p.seconds ? undefined : ex.dose.reps), seconds: p.seconds ?? (p.reps ? undefined : ex.dose.seconds), each_side: p.each_side ?? ex.dose.each_side } }] : [];
  });
}

/** What a set reads as: "3 × 10 each side", "3 × 40 s". */
export function doseText(d: Dose): string {
  const what = d.reps ? `${d.reps}` : d.seconds ? `${d.seconds} s` : "";
  return `${d.sets} × ${what}${d.each_side ? " each side" : ""}`.trim();
}

/** Roughly how long an exercise takes: its work (3 s a rep) and a minute's rest between sets. */
export function doseSeconds(d: Dose): number {
  const work = (d.reps ? d.reps * 3 : (d.seconds ?? 30)) * (d.each_side ? 2 : 1);
  return d.sets * work + (d.sets - 1) * 60;
}

/** Every muscle a routine works: primary if any exercise works it hard, else secondary. */
export function musclesOf(items: Array<{ ex: Exercise }>): { primary: Muscle[]; secondary: Muscle[] } {
  const primary = new Set<Muscle>();
  const secondary = new Set<Muscle>();
  for (const { ex } of items) {
    ex.primary.forEach((m) => primary.add(m));
    ex.secondary.forEach((m) => secondary.add(m));
  }
  return { primary: [...primary], secondary: [...secondary].filter((m) => !primary.has(m)) };
}

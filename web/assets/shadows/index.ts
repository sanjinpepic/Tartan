/** Floor shadows baked in Blender (scripts/blender/render-shadows.py; generated, don't edit). */
import s_back_squat_f from "./back_squat-f.png";
import s_back_squat_m from "./back_squat-m.png";
import s_barbell_row_f from "./barbell_row-f.png";
import s_barbell_row_m from "./barbell_row-m.png";
import s_bench_dip_f from "./bench_dip-f.png";
import s_bench_dip_m from "./bench_dip-m.png";
import s_bench_press_f from "./bench_press-f.png";
import s_bench_press_m from "./bench_press-m.png";
import s_bird_dog_f from "./bird_dog-f.png";
import s_bird_dog_m from "./bird_dog-m.png";
import s_calf_raise_f from "./calf_raise-f.png";
import s_calf_raise_m from "./calf_raise-m.png";
import s_crunch_f from "./crunch-f.png";
import s_crunch_m from "./crunch-m.png";
import s_dead_bug_f from "./dead_bug-f.png";
import s_dead_bug_m from "./dead_bug-m.png";
import s_deadlift_f from "./deadlift-f.png";
import s_deadlift_m from "./deadlift-m.png";
import s_dumbbell_curl_f from "./dumbbell_curl-f.png";
import s_dumbbell_curl_m from "./dumbbell_curl-m.png";
import s_glute_bridge_f from "./glute_bridge-f.png";
import s_glute_bridge_m from "./glute_bridge-m.png";
import s_goblet_squat_f from "./goblet_squat-f.png";
import s_goblet_squat_m from "./goblet_squat-m.png";
import s_hip_flexor_stretch_f from "./hip_flexor_stretch-f.png";
import s_hip_flexor_stretch_m from "./hip_flexor_stretch-m.png";
import s_hip_thrust_f from "./hip_thrust-f.png";
import s_hip_thrust_m from "./hip_thrust-m.png";
import s_jump_squat_f from "./jump_squat-f.png";
import s_jump_squat_m from "./jump_squat-m.png";
import s_kettlebell_swing_f from "./kettlebell_swing-f.png";
import s_kettlebell_swing_m from "./kettlebell_swing-m.png";
import s_lateral_raise_f from "./lateral_raise-f.png";
import s_lateral_raise_m from "./lateral_raise-m.png";
import s_mountain_climber_f from "./mountain_climber-f.png";
import s_mountain_climber_m from "./mountain_climber-m.png";
import s_overhead_press_f from "./overhead_press-f.png";
import s_overhead_press_m from "./overhead_press-m.png";
import s_plank_f from "./plank-f.png";
import s_plank_m from "./plank-m.png";
import s_pogo_hops_f from "./pogo_hops-f.png";
import s_pogo_hops_m from "./pogo_hops-m.png";
import s_pull_up_f from "./pull_up-f.png";
import s_pull_up_m from "./pull_up-m.png";
import s_push_up_f from "./push_up-f.png";
import s_push_up_m from "./push_up-m.png";
import s_rdl_f from "./rdl-f.png";
import s_rdl_m from "./rdl-m.png";
import s_reverse_lunge_f from "./reverse_lunge-f.png";
import s_reverse_lunge_m from "./reverse_lunge-m.png";
import s_side_plank_f from "./side_plank-f.png";
import s_side_plank_m from "./side_plank-m.png";
import s_single_leg_bridge_f from "./single_leg_bridge-f.png";
import s_single_leg_bridge_m from "./single_leg_bridge-m.png";
import s_single_leg_calf_raise_f from "./single_leg_calf_raise-f.png";
import s_single_leg_calf_raise_m from "./single_leg_calf_raise-m.png";
import s_single_leg_rdl_f from "./single_leg_rdl-f.png";
import s_single_leg_rdl_m from "./single_leg_rdl-m.png";
import s_split_squat_f from "./split_squat-f.png";
import s_split_squat_m from "./split_squat-m.png";
import s_squat_f from "./squat-f.png";
import s_squat_m from "./squat-m.png";
import s_stand_f from "./stand-f.png";
import s_stand_m from "./stand-m.png";
import s_step_up_f from "./step_up-f.png";
import s_step_up_m from "./step_up-m.png";

/** Per exercise and body: the strip (one square per key pose, white = shadow), and the floor square it covers. */
export const SHADOWS: Record<string, { url: string; poses: number; x: number; z: number; size: number }> = {
  "back_squat-f": { url: s_back_squat_f, poses: 2, x: 0.0, z: 0.001, size: 3.98 },
  "back_squat-m": { url: s_back_squat_m, poses: 2, x: 0.0, z: 0.002, size: 3.98 },
  "barbell_row-f": { url: s_barbell_row_f, poses: 2, x: 0.0, z: 0.271, size: 3.98 },
  "barbell_row-m": { url: s_barbell_row_m, poses: 2, x: 0.0, z: 0.279, size: 3.98 },
  "bench_dip-f": { url: s_bench_dip_f, poses: 2, x: 0.064, z: 0.145, size: 3.34 },
  "bench_dip-m": { url: s_bench_dip_m, poses: 2, x: 0.045, z: 0.121, size: 3.3 },
  "bench_press-f": { url: s_bench_press_f, poses: 2, x: 0.001, z: -0.274, size: 3.98 },
  "bench_press-m": { url: s_bench_press_m, poses: 2, x: 0.001, z: -0.245, size: 3.98 },
  "bird_dog-f": { url: s_bird_dog_f, poses: 4, x: 0.001, z: -0.088, size: 3.91 },
  "bird_dog-m": { url: s_bird_dog_m, poses: 4, x: -0.0, z: -0.067, size: 4.0 },
  "calf_raise-f": { url: s_calf_raise_f, poses: 2, x: 0.0, z: 0.094, size: 2.28 },
  "calf_raise-m": { url: s_calf_raise_m, poses: 2, x: 0.0, z: 0.106, size: 2.37 },
  "crunch-f": { url: s_crunch_f, poses: 2, x: 0.0, z: -0.181, size: 3.27 },
  "crunch-m": { url: s_crunch_m, poses: 2, x: 0.0, z: -0.14, size: 3.29 },
  "dead_bug-f": { url: s_dead_bug_f, poses: 4, x: 0.0, z: -0.141, size: 3.83 },
  "dead_bug-m": { url: s_dead_bug_m, poses: 4, x: 0.0, z: -0.156, size: 3.91 },
  "deadlift-f": { url: s_deadlift_f, poses: 2, x: 0.0, z: 0.269, size: 3.98 },
  "deadlift-m": { url: s_deadlift_m, poses: 2, x: 0.0, z: 0.27, size: 3.98 },
  "dumbbell_curl-f": { url: s_dumbbell_curl_f, poses: 2, x: 0.0, z: 0.108, size: 2.6 },
  "dumbbell_curl-m": { url: s_dumbbell_curl_m, poses: 2, x: 0.0, z: 0.117, size: 2.75 },
  "glute_bridge-f": { url: s_glute_bridge_f, poses: 2, x: 0.0, z: -0.181, size: 3.27 },
  "glute_bridge-m": { url: s_glute_bridge_m, poses: 2, x: -0.0, z: -0.14, size: 3.29 },
  "goblet_squat-f": { url: s_goblet_squat_f, poses: 2, x: 0.0, z: 0.047, size: 2.49 },
  "goblet_squat-m": { url: s_goblet_squat_m, poses: 2, x: 0.0, z: 0.041, size: 2.52 },
  "hip_flexor_stretch-f": { url: s_hip_flexor_stretch_f, poses: 2, x: -0.196, z: -0.014, size: 2.99 },
  "hip_flexor_stretch-m": { url: s_hip_flexor_stretch_m, poses: 2, x: -0.149, z: -0.01, size: 3.07 },
  "hip_thrust-f": { url: s_hip_thrust_f, poses: 2, x: -0.003, z: -0.223, size: 3.99 },
  "hip_thrust-m": { url: s_hip_thrust_m, poses: 2, x: -0.014, z: -0.228, size: 3.98 },
  "jump_squat-f": { url: s_jump_squat_f, poses: 3, x: 0.0, z: -0.048, size: 2.88 },
  "jump_squat-m": { url: s_jump_squat_m, poses: 3, x: 0.0, z: -0.062, size: 2.97 },
  "kettlebell_swing-f": { url: s_kettlebell_swing_f, poses: 2, x: 0.0, z: 0.368, size: 2.86 },
  "kettlebell_swing-m": { url: s_kettlebell_swing_m, poses: 2, x: 0.0, z: 0.416, size: 2.93 },
  "lateral_raise-f": { url: s_lateral_raise_f, poses: 2, x: 0.0, z: 0.09, size: 3.44 },
  "lateral_raise-m": { url: s_lateral_raise_m, poses: 2, x: 0.0, z: 0.112, size: 3.62 },
  "mountain_climber-f": { url: s_mountain_climber_f, poses: 2, x: 0.005, z: -0.01, size: 3.55 },
  "mountain_climber-m": { url: s_mountain_climber_m, poses: 2, x: 0.005, z: -0.035, size: 3.55 },
  "overhead_press-f": { url: s_overhead_press_f, poses: 2, x: 0.0, z: 0.149, size: 3.98 },
  "overhead_press-m": { url: s_overhead_press_m, poses: 2, x: 0.0, z: 0.139, size: 3.98 },
  "plank-f": { url: s_plank_f, poses: 2, x: -0.001, z: -0.095, size: 3.62 },
  "plank-m": { url: s_plank_m, poses: 2, x: -0.001, z: -0.063, size: 3.7 },
  "pogo_hops-f": { url: s_pogo_hops_f, poses: 2, x: 0.0, z: 0.226, size: 2.38 },
  "pogo_hops-m": { url: s_pogo_hops_m, poses: 2, x: 0.0, z: 0.264, size: 2.45 },
  "pull_up-f": { url: s_pull_up_f, poses: 2, x: 0.0, z: 0.151, size: 3.14 },
  "pull_up-m": { url: s_pull_up_m, poses: 2, x: 0.0, z: 0.154, size: 3.14 },
  "push_up-f": { url: s_push_up_f, poses: 2, x: 0.004, z: -0.031, size: 3.59 },
  "push_up-m": { url: s_push_up_m, poses: 2, x: 0.003, z: -0.064, size: 3.61 },
  "rdl-f": { url: s_rdl_f, poses: 2, x: 0.0, z: 0.234, size: 3.98 },
  "rdl-m": { url: s_rdl_m, poses: 2, x: 0.0, z: 0.231, size: 3.98 },
  "reverse_lunge-f": { url: s_reverse_lunge_f, poses: 2, x: -0.056, z: -0.388, size: 2.99 },
  "reverse_lunge-m": { url: s_reverse_lunge_m, poses: 2, x: -0.048, z: -0.418, size: 3.07 },
  "side_plank-f": { url: s_side_plank_f, poses: 2, x: 0.032, z: 0.169, size: 3.58 },
  "side_plank-m": { url: s_side_plank_m, poses: 2, x: 0.053, z: 0.201, size: 3.59 },
  "single_leg_bridge-f": { url: s_single_leg_bridge_f, poses: 2, x: 0.001, z: -0.02, size: 3.59 },
  "single_leg_bridge-m": { url: s_single_leg_bridge_m, poses: 2, x: -0.001, z: 0.012, size: 3.59 },
  "single_leg_calf_raise-f": { url: s_single_leg_calf_raise_f, poses: 2, x: 0.079, z: -0.047, size: 2.5 },
  "single_leg_calf_raise-m": { url: s_single_leg_calf_raise_m, poses: 2, x: 0.103, z: -0.042, size: 2.53 },
  "single_leg_rdl-f": { url: s_single_leg_rdl_f, poses: 2, x: 0.053, z: -0.092, size: 3.54 },
  "single_leg_rdl-m": { url: s_single_leg_rdl_m, poses: 2, x: 0.073, z: -0.116, size: 3.57 },
  "split_squat-f": { url: s_split_squat_f, poses: 2, x: -0.045, z: -0.22, size: 3.33 },
  "split_squat-m": { url: s_split_squat_m, poses: 2, x: -0.02, z: -0.221, size: 3.39 },
  "squat-f": { url: s_squat_f, poses: 2, x: 0.0, z: 0.167, size: 2.72 },
  "squat-m": { url: s_squat_m, poses: 2, x: 0.0, z: 0.186, size: 2.8 },
  "stand-f": { url: s_stand_f, poses: 1, x: 0.0, z: 0.053, size: 2.28 },
  "stand-m": { url: s_stand_m, poses: 1, x: 0.0, z: 0.06, size: 2.37 },
  "step_up-f": { url: s_step_up_f, poses: 2, x: 0.09, z: 0.265, size: 2.7 },
  "step_up-m": { url: s_step_up_m, poses: 2, x: 0.095, z: 0.284, size: 2.73 },
};

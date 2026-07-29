// 场景状态机 + 感知结果置信门槛校验。
// 移植自 pub-local-jarvis orchestrator/scene.py (CourseSceneStabilizer) 与
// orchestrator/service.py _parse_perception 中的 game/course 证据门槛逻辑。
// 纯逻辑，无 Electron 依赖，普通 node 可直接 require。

const VALID_SCENES = new Set(["game", "course", "other"]);

const EVIDENCE_KEYS = [
  "game_surface",
  "interactive_gameplay",
  "game_video_or_stream",
  "fullscreen_game_media",
  "active_instruction",
  "course_surface",
  "instructional_audio",
  "ordinary_browsing",
  "non_game_surface",
];

const GAME_CONFIDENCE_THRESHOLD = 0.72;
const COURSE_CONFIDENCE_THRESHOLD = 0.78;

// 三态稳定器：other ↔ game/course 需连续证据才会切换。
// enter=2 帧、exit=2 帧；game 进入用 gameEnterSamples（默认同 enter）。
class CourseSceneStabilizer {
  constructor({ enterSamples = 2, exitSamples = 2, gameEnterSamples = null } = {}) {
    if (
      enterSamples < 1 ||
      exitSamples < 1 ||
      (gameEnterSamples !== null && gameEnterSamples < 1)
    ) {
      throw new Error("sample counts must be positive");
    }
    this.enterSamples = enterSamples;
    this.exitSamples = exitSamples;
    this.gameEnterSamples =
      gameEnterSamples === null ? enterSamples : gameEnterSamples;
    this.current = "other";
    this._candidate = null;
    this._streak = 0;
  }

  force(scene) {
    this.current = scene;
    this._candidate = null;
    this._streak = 0;
  }

  // exitSamples 为 null 时用默认 this.exitSamples
  observe(scene, { exitSamples = null } = {}) {
    if (exitSamples !== null && exitSamples < 1) {
      throw new Error("exitSamples must be positive");
    }
    if (!VALID_SCENES.has(scene)) scene = "other";
    if (scene === this.current) {
      this.force(scene);
      return this.current;
    }
    this._streak = this._candidate === scene ? this._streak + 1 : 1;
    this._candidate = scene;
    let needed;
    if (this.current === "other") {
      needed = scene === "game" ? this.gameEnterSamples : this.enterSamples;
    } else {
      needed = exitSamples === null ? this.exitSamples : exitSamples;
    }
    if (this._streak >= needed) this.force(scene);
    return this.current;
  }
}

// game/course 双重置信门槛校验（移植 service.py _parse_perception 第 1166-1205 行）。
// 输入为归一化后的感知结果 {scene, confidence, scene_evidence, barrage 相关字段…}，
// 不满足门槛时降级为 'other'。返回修正后的 scene（原地修改 parsed.scene）。
function validateScene(parsed) {
  const evidence = parsed.scene_evidence || {};
  let scene = VALID_SCENES.has(parsed.scene) ? parsed.scene : "other";
  const confidence = Number(parsed.confidence) || 0;
  // 与 Python 版 `not evidence` 对齐：只有原始 scene_evidence 为空对象时才算"未提供证据"；
  // 调用方可用 _evidenceProvided 显式告知，缺省时退化为"无 true 键"判定。
  const hasEvidence =
    parsed._evidenceProvided !== undefined
      ? parsed._evidenceProvided === true
      : Object.values(evidence).some((v) => v === true);

  if (scene === "game") {
    let interactive = evidence.interactive_gameplay === true;
    // 模型声称 game 且产出了弹幕/发言内容但未给证据键时，视作有交互证据
    if (
      !hasEvidence &&
      (parsed.barrage ||
        (Array.isArray(parsed.barrage_candidates) &&
          parsed.barrage_candidates.length) ||
        parsed.assistant_message)
    ) {
      interactive = true;
    }
    const gameSurface = evidence.game_surface === true;
    const passiveGameMedia = evidence.game_video_or_stream === true;
    const fullscreenGameMedia = evidence.fullscreen_game_media === true;
    const validGameScene =
      evidence.non_game_surface !== true &&
      (interactive ||
        (gameSurface && !passiveGameMedia) ||
        (passiveGameMedia && fullscreenGameMedia));
    if (confidence < GAME_CONFIDENCE_THRESHOLD || !validGameScene) {
      scene = "other";
    }
  } else if (scene === "course") {
    let activeInstruction = evidence.active_instruction === true;
    let courseSurface = evidence.course_surface === true;
    let instructionalAudio = evidence.instructional_audio === true;
    if (!hasEvidence && (parsed.course_transcript || parsed.course_note)) {
      activeInstruction = true;
      instructionalAudio = !!parsed.course_transcript;
      courseSurface = !!parsed.course_note;
    }
    // 讲解语音本身就构成教学现场；浏览类内容需要板书+语音双证据
    activeInstruction = activeInstruction || instructionalAudio;
    const browsingWithoutCorroboration =
      evidence.ordinary_browsing === true &&
      !(courseSurface && instructionalAudio);
    if (
      confidence < COURSE_CONFIDENCE_THRESHOLD ||
      !activeInstruction ||
      !(courseSurface || instructionalAudio) ||
      browsingWithoutCorroboration
    ) {
      scene = "other";
    }
  }

  parsed.scene = scene;
  return scene;
}

// game 退出样本数规则（移植 service.py _handle_perception）：
// 当前在 game、新观测非 game 时——
// 明确退出（证据显示 non_game_surface 或 ordinary_browsing）1 帧退出；
// 模糊退出（只是没看到游戏了）需 gameUncertainExitSamples（2）帧。
function resolveGameExitSamples(
  currentScene,
  observedScene,
  sceneEvidence,
  { gameExitSamples = 1, gameUncertainExitSamples = 2 } = {}
) {
  if (currentScene !== "game" || observedScene === "game") return null;
  const evidence = sceneEvidence || {};
  const uncertain =
    observedScene === "other" &&
    evidence.non_game_surface !== true &&
    evidence.ordinary_browsing !== true;
  return uncertain ? gameUncertainExitSamples : gameExitSamples;
}

module.exports = {
  CourseSceneStabilizer,
  validateScene,
  resolveGameExitSamples,
  EVIDENCE_KEYS,
  VALID_SCENES,
  GAME_CONFIDENCE_THRESHOLD,
  COURSE_CONFIDENCE_THRESHOLD,
};

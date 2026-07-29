// sceneStabilizer.js 单元测试：场景状态机 + 置信门槛校验 + 退出样本规则
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  CourseSceneStabilizer,
  validateScene,
  resolveGameExitSamples,
} = require("../src/service/perception/sceneStabilizer.js");

test("enter=2：连续 2 帧才从 other 进入 game", () => {
  const s = new CourseSceneStabilizer();
  assert.equal(s.observe("game"), "other"); // 第 1 帧，未确认
  assert.equal(s.observe("game"), "game"); // 第 2 帧，确认进入
});

test("exit=2：连续 2 帧才从 game 退出到 other", () => {
  const s = new CourseSceneStabilizer();
  s.force("game");
  assert.equal(s.observe("other"), "game"); // 第 1 帧，未退出
  assert.equal(s.observe("other"), "other"); // 第 2 帧，确认退出
});

test("候选场景中途换人时计数重新开始", () => {
  const s = new CourseSceneStabilizer();
  s.observe("game"); // game 计 1
  assert.equal(s.observe("course"), "other"); // 换成 course，重新计 1
  assert.equal(s.observe("course"), "course"); // course 计 2，进入
});

test("相同场景直接确认并重置计数", () => {
  const s = new CourseSceneStabilizer();
  s.observe("game"); // game 计 1
  assert.equal(s.observe("other"), "other"); // 与当前相同，重置候选计数
  assert.equal(s.observe("game"), "other"); // game 重新计 1，仍不切换
  assert.equal(s.observe("game"), "game"); // 再一帧才进入
});

test("force() 直接设置场景并清空计数", () => {
  const s = new CourseSceneStabilizer();
  s.force("game");
  assert.equal(s.current, "game");
  // 计数已清空，退出仍需连续 2 帧
  assert.equal(s.observe("other"), "game");
  assert.equal(s.observe("other"), "other");
});

test("非法场景按 other 处理", () => {
  const s = new CourseSceneStabilizer();
  s.force("game");
  // 非法值视为 other，属退出流程，需 2 帧
  assert.equal(s.observe("weird"), "game");
  assert.equal(s.observe("weird"), "other");
});

test("observe 支持覆盖 exitSamples（明确退出 1 帧）", () => {
  const s = new CourseSceneStabilizer();
  s.force("game");
  assert.equal(s.observe("other", { exitSamples: 1 }), "other");
});

test("构造参数非正数直接抛错", () => {
  assert.throws(() => new CourseSceneStabilizer({ enterSamples: 0 }));
  assert.throws(() => new CourseSceneStabilizer({ exitSamples: 0 }));
  assert.throws(() => new CourseSceneStabilizer({ gameEnterSamples: 0 }));
});

test("validateScene：game 证据齐全且置信 ≥0.72 时保留", () => {
  const parsed = {
    scene: "game",
    confidence: 0.8,
    scene_evidence: { game_surface: true, interactive_gameplay: true },
  };
  assert.equal(validateScene(parsed), "game");
  assert.equal(parsed.scene, "game");
});

test("validateScene：game 置信不足 0.72 降级 other", () => {
  const parsed = {
    scene: "game",
    confidence: 0.71,
    scene_evidence: { game_surface: true, interactive_gameplay: true },
  };
  assert.equal(validateScene(parsed), "other");
});

test("validateScene：game 缺证据键降级 other", () => {
  const parsed = { scene: "game", confidence: 0.9, scene_evidence: {} };
  assert.equal(validateScene(parsed), "other");
});

test("validateScene：game 无证据但有弹幕内容时视为有交互证据", () => {
  const parsed = {
    scene: "game",
    confidence: 0.9,
    scene_evidence: {},
    barrage_candidates: ["这波打得漂亮"],
  };
  assert.equal(validateScene(parsed), "game");
});

test("validateScene：被动游戏视频需全屏证据，否则降级", () => {
  const passive = {
    scene: "game",
    confidence: 0.9,
    scene_evidence: { game_surface: true, game_video_or_stream: true },
  };
  assert.equal(validateScene(passive), "other");
  const fullscreen = {
    scene: "game",
    confidence: 0.9,
    scene_evidence: {
      game_surface: true,
      game_video_or_stream: true,
      fullscreen_game_media: true,
    },
  };
  assert.equal(validateScene(fullscreen), "game");
});

test("validateScene：non_game_surface 为 true 时 game 必然降级", () => {
  const parsed = {
    scene: "game",
    confidence: 0.95,
    scene_evidence: { interactive_gameplay: true, non_game_surface: true },
  };
  assert.equal(validateScene(parsed), "other");
});

test("validateScene：course 证据齐全且置信 ≥0.78 时保留", () => {
  const parsed = {
    scene: "course",
    confidence: 0.8,
    scene_evidence: { active_instruction: true, course_surface: true },
  };
  assert.equal(validateScene(parsed), "course");
});

test("validateScene：course 置信不足 0.78 降级 other", () => {
  const parsed = {
    scene: "course",
    confidence: 0.77,
    scene_evidence: { active_instruction: true, course_surface: true },
  };
  assert.equal(validateScene(parsed), "other");
});

test("validateScene：course 缺教学证据降级 other", () => {
  const parsed = { scene: "course", confidence: 0.9, scene_evidence: {} };
  assert.equal(validateScene(parsed), "other");
});

test("validateScene：instructional_audio 单独成立即可支撑 course", () => {
  const parsed = {
    scene: "course",
    confidence: 0.85,
    scene_evidence: { instructional_audio: true },
  };
  assert.equal(validateScene(parsed), "course");
});

test("validateScene：ordinary_browsing 无板书+语音佐证时降级", () => {
  const parsed = {
    scene: "course",
    confidence: 0.9,
    scene_evidence: { active_instruction: true, ordinary_browsing: true },
  };
  assert.equal(validateScene(parsed), "other");
  const corroborated = {
    scene: "course",
    confidence: 0.9,
    scene_evidence: {
      active_instruction: true,
      ordinary_browsing: true,
      course_surface: true,
      instructional_audio: true,
    },
  };
  assert.equal(validateScene(corroborated), "course");
});

test("validateScene：course 无证据但有转写内容时按兜底规则保留", () => {
  const parsed = {
    scene: "course",
    confidence: 0.85,
    scene_evidence: {},
    course_transcript: "下面我们推导牛顿第二定律",
  };
  assert.equal(validateScene(parsed), "course");
});

test("resolveGameExitSamples：明确退出 1 帧、模糊退出 2 帧", () => {
  // 明确退出：证据显示 non_game_surface
  assert.equal(
    resolveGameExitSamples("game", "other", { non_game_surface: true }),
    1
  );
  // 明确退出：证据显示 ordinary_browsing
  assert.equal(
    resolveGameExitSamples("game", "other", { ordinary_browsing: true }),
    1
  );
  // 模糊退出：只是没看到游戏了
  assert.equal(resolveGameExitSamples("game", "other", {}), 2);
  // 观测到具体非 other 场景不算模糊
  assert.equal(resolveGameExitSamples("game", "course", {}), 1);
});

test("resolveGameExitSamples：非 game 退出场景返回 null", () => {
  assert.equal(resolveGameExitSamples("other", "course", {}), null);
  assert.equal(resolveGameExitSamples("game", "game", {}), null);
});

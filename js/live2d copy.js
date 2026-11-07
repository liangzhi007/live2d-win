// ===== 可修改的项目配置 =====
// 更换模型时，通常只需要修改 MODEL.path；模型专用的命中区域和参数 ID
// 则在 INTERACTION_CONFIG 中配置。
const MODEL = {
  path: "live2d/菊理千姬/model3.json",
  scale: 0.3,
  x: 500
};
const InteractionConfig = {
  "headArea": "摸头",
  "上下": [
    {
      "裙子": ["PARAM_XIANQUNZI","掀裙子时","掀裙子后"]
    }
  ],
  "左右": [
    {
      "左腿": ["PARAM_CHEWAZI_02","","腿"],
      "右腿": ["PARAM_CHEWAZI_L_02","","腿"]
    }
  ]
}

const live2d = PIXI.live2d;

/* 页面入口：加载模型和配置，创建 Pixi 应用，再安装展示控件与交互。*/
(async function main() {
  const app = createApplication();
  const modelConfig = await loadModelConfig(MODEL.path);
  const Skeleton = modelConfig.Skeleton ?? false;
  if (Skeleton) {  // 将模型的 Skeleton 参数 ID 暴露到全局，方便在浏览器控制台查看和调试。
    globalThis.LIVE2D_PARAMETER_IDS = Skeleton;
  }
  const model = await live2d.Live2DModel.from(MODEL.path);
  const INTERACTION_CONFIG = modelConfig.InteractionConfig ?? [];
  console.log("INTERACTION_CONFIG", INTERACTION_CONFIG);
  const hitAreaNames = (modelConfig.HitAreas ?? [])
    .map((area) => area.Name)
    .filter(Boolean);
  const motionNames = Object.keys(modelConfig.FileReferences?.Motions ?? {});
  const expressionNames = (modelConfig.FileReferences?.Expressions ?? [])
    .map((expression) => expression.Name)
    .filter(Boolean);
  app.stage.addChild(model);
  model.scale.set(MODEL.scale);
  model.x = MODEL.x;

  addModelFrame(model);
  addHitAreaSelector(model);
  addMotionSelector(model, motionNames);
  addExpressionSelector(model, expressionNames);

  const isDraggingEnabled = addDraggableToggle(model);
  setupInteractions(model, app.view, motionNames, isDraggingEnabled, INTERACTION_CONFIG);
})();

/* 创建 Pixi 应用，并明确检查页面必须提供的画布和控件容器。*/
function createApplication() {
  const canvas = document.getElementById("canvas");
  const control = document.getElementById("control");

  if (!canvas) throw new Error('页面缺少 id="canvas" 的画布元素。');
  if (!control) throw new Error('页面缺少 id="control" 的控件容器。');

  return new PIXI.Application({
    view: canvas,
    autoStart: true,
    resizeTo: window,
    backgroundColor: 0x333333
  });
}

/* 读取模型 JSON，用于生成动作列表和命中区域列表。*/
async function loadModelConfig(modelPath) {
  const response = await fetch(modelPath);
  if (!response.ok) {
    throw new Error(`无法加载模型动作配置：${response.status} ${modelPath}`);
  }

  return response.json();
}

/* 根据拖动开关统一安装模型专用的点击、拖拽和光标交互。*/
function setupInteractions(model, canvas, motionNames, isDraggingEnabled, INTERACTION_CONFIG) {
  if (INTERACTION_CONFIG.headArea ?? false) {
    setupHeadInteraction(model, isDraggingEnabled);
  }
  if (INTERACTION_CONFIG.上下 ?? false) {
    INTERACTION_CONFIG.上下.forEach((item) => {
      setupSkirtInteraction(model, isDraggingEnabled, item);
    });
  };
  if (INTERACTION_CONFIG.左右 ?? false) {
    INTERACTION_CONFIG.左右.forEach((item) => {
      setupLegInteraction(model, isDraggingEnabled, item);
    });
  }
  setupHitAreaMotions(model, motionNames, isDraggingEnabled);
  setupHeadCursor(model, canvas, isDraggingEnabled, INTERACTION_CONFIG);
}

/** 按住摸头区域后，根据按压时长选择成功或取消动作。 */
function setupHeadInteraction(model, isDraggingEnabled) {
  let pressedAt = null;

  model.on("pointerdown", (event) => {
    if (isDraggingEnabled()) return;

    const { x, y } = event.data.global;
    if (!model.hitTest(x, y).includes("摸头")) return;

    pressedAt = Date.now();
    model.motion("摸头时", undefined, 2);
  });

  /** 松开或拖出模型时都结束按压，避免状态残留。*/
  function finishHeadPress() {
    if (pressedAt === null) return;

    const heldDuration = Date.now() - pressedAt;
    pressedAt = null;
    model.motion(heldDuration >= 2000 ? "完成摸头" : "未摸头", undefined, 3);
  }

  model.on("pointerup", finishHeadPress);
  model.on("pointerupoutside", finishHeadPress);
}

/** 在区域按下并上下移动时，调整参数；松开后播放结束动作。*/
function setupSkirtInteraction(model, isDraggingEnabled, INTERACTION_CONFIG) {
  let dragState = null;
  let frozenState = null;

  // 拖动结束后仍持续应用最后的参数值，避免动作覆盖。
  model.internalModel.on("afterModelUpdate", () => {
    if (!frozenState) return;

    model.internalModel.coreModel.setParameterValueById(
      frozenState.parameterId,
      frozenState.value
    );
  });

  model.on("pointerdown", (event) => {
    if (isDraggingEnabled()) return;

    const { x, y } = event.data.global;
    const hitAreas = model.hitTest(x, y);
    const areaName = Object.keys(INTERACTION_CONFIG).find((name) =>
      hitAreas.includes(name)
    );
    if (!areaName) return;
    model.expression("脸红");
    model.motion(INTERACTION_CONFIG[areaName][1], undefined, 3);
    const parameterId = INTERACTION_CONFIG[areaName][0];
    const startValue =
      model.internalModel.coreModel.getParameterValueById(parameterId);

    dragState = {
      parameterId,
      startY: y,
      startValue,
      value: startValue,
      areaName
    };
    frozenState = { parameterId, value: startValue };
  });

  model.on("pointermove", (event) => {
    if (isDraggingEnabled() || !dragState) return;

    const upwardDistance = dragState.startY - event.data.global.y;
    const value = Math.max(
      0,
      Math.min(1, dragState.startValue + upwardDistance * 0.01)
    );

    dragState.value = value;
    frozenState.value = value;

    // 立即更新，afterModelUpdate 则负责抵抗动作覆盖。
    model.internalModel.coreModel.setParameterValueById(
      dragState.parameterId,
      value
    );
  });

  function finishSkirtDrag() {
    if (!dragState) return;

    const { areaName, parameterId } = dragState;
    dragState = null;

    // 松开后持续保持为 0；结束动作仍会播放，但不能改动这个参数。
    frozenState = { parameterId, value: 0 };
    model.internalModel.coreModel.setParameterValueById(parameterId, 0);

    model.expression("正常");
    model.motion(INTERACTION_CONFIG[areaName][2], undefined, 3);
  }

  model.on("pointerup", finishSkirtDrag);
  model.on("pointerupoutside", finishSkirtDrag);
}

/** 拖动左右命中区域时临时设置对应参数，松开后复位并播放动作。*/
function setupLegInteraction(model, isDraggingEnabled, INTERACTION_CONFIG) {
  let dragState = null;

  model.on("pointerdown", (event) => {
    if (isDraggingEnabled()) return;

    const { x, y } = event.data.global;
    const hitAreas = model.hitTest(x, y);
    const areaName = Object.keys(INTERACTION_CONFIG).find((name) =>
      hitAreas.includes(name)
    );
    if (!areaName) return;
    model.expression("脸红");
    dragState = {
      parameterId: INTERACTION_CONFIG[areaName][0],
      startX: x,
      startValue: model.internalModel.coreModel.getParameterValueById(INTERACTION_CONFIG[areaName][0]),//参数初始值
      areaName
    };
  });

  model.on("pointermove", (event) => {
    if (isDraggingEnabled() || !dragState) return;

    const upwardDistance = Math.abs(event.data.global.x - dragState.startX);
    const value = Math.max(
      0,
      Math.min(1, dragState.startValue + upwardDistance * 0.01)
    );

    model.internalModel.coreModel.setParameterValueById(
      dragState.parameterId,
      value
    );
  });

  /** 拖动结束时复位腿部参数；向上拖动时不播放收尾动作。 */
  function finishLegDrag() {
    if (!dragState) return;

    const { parameterId, areaName } = dragState;
    dragState = null;
    model.expression("正常");
    model.internalModel.coreModel.setParameterValueById(parameterId, 0);
    model.motion(INTERACTION_CONFIG[areaName][2], undefined, 3);
  }

  model.on("pointerup", finishLegDrag);
  model.on("pointerupoutside", finishLegDrag);
}

/** 点击模型上配置过的普通命中区域时，播放同名动作。*/
function setupHitAreaMotions(model, motionNames, isDraggingEnabled) {
  model.on("hit", (hitAreas) => {
    if (isDraggingEnabled()) return;
    const areaName = hitAreas.find((name) => motionNames.includes(name));
    if (areaName) {
      model.motion(areaName);
    } else {
      const areaName = hitAreas.find((name) => motionNames.includes(name.slice(1)));
      if (areaName) {
        model.motion(areaName.slice(1));
      }
    }
  });
}

/** 鼠标悬停摸头区域时显示可点击光标，按下后显示抓取光标。*/
function setupHeadCursor(model, canvas, isDraggingEnabled, INTERACTION_CONFIG) {
  let isGrabbingHead = false;

  model.on("pointermove", (event) => {
    if (isGrabbingHead) {
      canvas.style.cursor = "grabbing";
      return;
    }

    if (isDraggingEnabled()) {
      canvas.style.cursor = "default";
      return;
    }

    const { x, y } = event.data.global;
    canvas.style.cursor = model.hitTest(x, y).includes(
      INTERACTION_CONFIG.headArea
    )
      ? "pointer"
      : "default";
  });

  model.on("pointerdown", (event) => {
    if (isDraggingEnabled()) return;

    const { x, y } = event.data.global;
    if (!model.hitTest(x, y).includes(INTERACTION_CONFIG.headArea)) return;

    isGrabbingHead = true;
    canvas.style.cursor = "grabbing";
  });

  /** 鼠标释放后恢复光标，并按释放位置重新判断是否仍可点击。*/
  function releaseHeadCursor(event) {
    isGrabbingHead = false;

    if (!event || isDraggingEnabled()) {
      canvas.style.cursor = "default";
      return;
    }

    const { x, y } = event.data.global;
    canvas.style.cursor = model.hitTest(x, y).includes(
      INTERACTION_CONFIG.headArea
    )
      ? "pointer"
      : "default";
  }

  model.on("pointerup", releaseHeadCursor);
  model.on("pointerupoutside", releaseHeadCursor);
}

/** 创建预设动作按钮；点击后播放所选动作并更新按钮选中状态。*/
function addMotionSelector(model, motionNames) {
  const section = document.createElement("section");
  const heading = document.createElement("p");
  const choices = document.createElement("div");

  section.className = "motion-selector";
  heading.textContent = "预设动作：";
  choices.className = "motion-choices";
  choices.setAttribute("aria-label", "预设动作");

  motionNames.forEach((motionName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "motion-choice";
    button.textContent = motionName;
    button.setAttribute("aria-pressed", "false");

    button.addEventListener("click", () => {
      choices.querySelectorAll(".motion-choice").forEach((choice) => {
        choice.classList.remove("selected");
        choice.setAttribute("aria-pressed", "false");
      });

      button.classList.add("selected");
      button.setAttribute("aria-pressed", "true");
      model.motion(motionName, undefined, 3);
    });

    choices.appendChild(button);
  });

  section.append(heading, choices);
  getControlContainer().appendChild(section);
}

/** 添加模型尺寸参考框，并提供显示/隐藏复选框。 */
function addModelFrame(model) {
  const frame = PIXI.Sprite.from(PIXI.Texture.WHITE);
  frame.width = model.internalModel.width;
  frame.height = model.internalModel.height;
  frame.alpha = 0.2;
  model.addChild(frame);

  addCheckbox("模型框架", (checked) => {
    frame.visible = checked;
  });
}

/** 添加命中区域轮廓控件，支持逐个选择、全选和前后切换。*/
function addHitAreaSelector(model) {
  const hitAreaFrames = new live2d.HitAreaFrames();
  model.addChild(hitAreaFrames);
  const allFrameTexts = hitAreaFrames.texts.slice();

  const selectedAreas = new Set();
  const areaCheckboxes = [];
  let currentAreaIndex = -1;

  hitAreaFrames.texts = [];

  const section = document.createElement("section");
  const heading = document.createElement("p");
  const allLabel = document.createElement("label");
  const allCheckbox = document.createElement("input");
  const previousButton = document.createElement("button");
  const nextButton = document.createElement("button");
  const choices = document.createElement("div");
  const navigation = document.createElement("div");

  section.className = "hit-area-selector";
  heading.textContent = "可点击区域：";
  allCheckbox.type = "checkbox";
  allCheckbox.id = "all-hit-areas";
  allLabel.htmlFor = allCheckbox.id;
  allLabel.append(allCheckbox, document.createTextNode(" 一键开启全部区域"));

  previousButton.type = "button";
  previousButton.textContent = "上一个可显示区域";
  nextButton.type = "button";
  nextButton.textContent = "下一个可显示区域";
  navigation.className = "hit-area-navigation";
  navigation.append(previousButton, nextButton);

  choices.className = "hit-area-choices";
  choices.setAttribute("aria-label", "可点击区域列表");

  /** 同步轮廓显示状态、每个选项和全选框的三态状态。*/
  function updateVisibleAreas() {
    hitAreaFrames.texts = allFrameTexts.filter((frameText) =>
      selectedAreas.has(frameText.text)
    );

    areaCheckboxes.forEach((checkbox, index) => {
      checkbox.checked = selectedAreas.has(allFrameTexts[index].text);
    });

    allCheckbox.checked =
      allFrameTexts.length > 0 && selectedAreas.size === allFrameTexts.length;
    allCheckbox.indeterminate =
      selectedAreas.size > 0 && selectedAreas.size < allFrameTexts.length;
  }

  /** 只显示指定索引的区域，并循环支持上一项/下一项操作。*/
  function showAreaAt(index) {
    if (allFrameTexts.length === 0) return;

    currentAreaIndex = (index + allFrameTexts.length) % allFrameTexts.length;
    selectedAreas.clear();
    selectedAreas.add(allFrameTexts[currentAreaIndex].text);
    updateVisibleAreas();
  }

  previousButton.addEventListener("click", () => {
    showAreaAt(
      currentAreaIndex < 0 ? allFrameTexts.length - 1 : currentAreaIndex - 1
    );
  });
  nextButton.addEventListener("click", () => {
    showAreaAt(currentAreaIndex + 1);
  });

  allCheckbox.addEventListener("change", () => {
    selectedAreas.clear();
    if (allCheckbox.checked) {
      allFrameTexts.forEach((frameText) => selectedAreas.add(frameText.text));
    }
    updateVisibleAreas();
  });

  allFrameTexts.forEach((frameText, index) => {
    const row = document.createElement("p");
    const checkbox = document.createElement("input");
    const label = document.createElement("label");

    checkbox.type = "checkbox";
    checkbox.id = `hit-area-${index}`;
    label.htmlFor = checkbox.id;
    label.textContent = frameText.text;
    areaCheckboxes.push(checkbox);

    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedAreas.add(frameText.text);
        currentAreaIndex = index;
      } else {
        selectedAreas.delete(frameText.text);
      }
      updateVisibleAreas();
    });

    row.append(checkbox, document.createTextNode(" "), label);
    choices.appendChild(row);
  });

  section.append(heading, allLabel, navigation, choices);
  getControlContainer().appendChild(section);
  updateVisibleAreas();
}

/** 创建通用复选框控件，并在初始化时立即同步一次当前状态。*/
function addCheckbox(name, onChange) {
  const control = getControlContainer();
  const id = name.replace(/\W/g, "").toLowerCase();
  let checkbox = document.getElementById(id);

  if (!checkbox) {
    const row = document.createElement("p");
    const label = document.createElement("label");
    checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = id;
    label.htmlFor = id;
    label.textContent = name;
    row.append(checkbox, document.createTextNode(" "), label);
    control.appendChild(row);
  }

  checkbox.addEventListener("change", () => onChange(checkbox.checked));
  onChange(checkbox.checked);
}

/** 获取页面控件容器；找不到时抛出明确错误，避免静默丢失界面控件。*/
function getControlContainer() {
  const control = document.getElementById("control");
  if (!control) throw new Error('页面缺少 id="control" 的控件容器。');
  return control;
}

/** 创建开关按钮，启用时允许拖动模型，并返回当前开关状态的读取函数。*/
function addDraggableToggle(model) {
  let enabled = false;
  const button = document.createElement("button");

  button.type = "button";
  model.interactive = true;

  /** 更新按钮文案、Pixi 鼠标状态，并在关闭时结束正在进行的拖动。*/
  function updateButton() {
    button.textContent = enabled ? "关闭拖动" : "开启拖动";
    model.buttonMode = enabled;
    if (!enabled) model.dragging = false;
  }

  button.addEventListener("click", () => {
    enabled = !enabled;
    updateButton();
  });

  model.on("pointerdown", (event) => {
    if (!enabled) return;

    model.dragging = true;
    model._pointerX = event.data.global.x - model.x;
    model._pointerY = event.data.global.y - model.y;
  });
  model.on("pointermove", (event) => {
    if (!enabled || !model.dragging) return;

    model.position.x = event.data.global.x - model._pointerX;
    model.position.y = event.data.global.y - model._pointerY;
  });
  model.on("pointerupoutside", () => {
    model.dragging = false;
  });
  model.on("pointerup", () => {
    model.dragging = false;
  });

  getControlContainer().appendChild(button);
  updateButton();
  return () => enabled;
}



/** 仅显示并打印传入的值，用于查看代码运行状态。 */
function showRunStep(value, duration = 1000) {
  let bubble = document.getElementById("run-step-bubble");

  if (!bubble) {
    bubble = document.createElement("div");
    bubble.id = "run-step-bubble";
    Object.assign(bubble.style, {
      position: "fixed",
      left: "50%",
      bottom: "24px",
      transform: "translateX(-50%)",
      zIndex: "99999",
      padding: "10px 16px",
      color: "#fff",
      background: "rgba(0, 0, 0, 0.8)",
      borderRadius: "8px",
      fontSize: "14px",
      maxWidth: "80vw",
      overflowWrap: "anywhere"
    });
    document.body.appendChild(bubble);
  }

  bubble.textContent =
    typeof value === "string" ? value : JSON.stringify(value) ?? String(value);

  console.log(value);

  clearTimeout(showRunStep.timer);
  if (duration > 0) {
    showRunStep.timer = setTimeout(() => bubble.remove(), duration);
  }
}

// 用法示例：在想观察的代码位置调用
// showRunStep("开始加载模型", MODEL.path);
// showRunStep("模型加载完成", model);
/**
 * 表情按钮
 */
function addExpressionSelector(model, expressionNames) {
  if (expressionNames.length === 0) return;

  const section = document.createElement("section");
  const heading = document.createElement("p");
  const choices = document.createElement("div");

  section.className = "expression-selector";
  heading.textContent = "表情：";
  choices.className = "expression-choices";
  choices.setAttribute("aria-label", "表情");

  expressionNames.forEach((expressionName) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "expression-choice";
    button.textContent = expressionName;
    button.setAttribute("aria-pressed", "false");

    button.addEventListener("click", () => {
      choices.querySelectorAll(".expression-choice").forEach((choice) => {
        choice.classList.remove("selected");
        choice.setAttribute("aria-pressed", "false");
      });

      button.classList.add("selected");
      button.setAttribute("aria-pressed", "true");
      model.expression(expressionName);
    });

    choices.appendChild(button);
  });

  section.append(heading, choices);
  getControlContainer().appendChild(section);
}

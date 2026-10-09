import { MotionGlobalConfig } from "framer-motion/dom";

// 模拟 DOM 不渲染动画帧；交互测试直接应用最终状态，避免卸载时取消动画。
// 动画的视觉效果应在浏览器中验证，未处理异常检查仍然启用。
MotionGlobalConfig.skipAnimations = true;

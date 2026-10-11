import type { Category } from '../core/types';

export interface ClassInfo {
  category: Category;
  /** Spoken name for warnings. */
  spoken: string;
  /** Typical real-world height and width in metres, used for distance from box size. */
  height: number;
  width: number;
}

/**
 * COCO classes EchoPath cares about. Anything else the detector reports is
 * ignored. Animals share the "person" timbre: they move and can step into
 * the path, unlike furniture.
 */
export const CLASS_INFO: Record<string, ClassInfo> = {
  person: { category: 'person', spoken: 'Person', height: 1.7, width: 0.5 },
  dog: { category: 'person', spoken: 'Dog', height: 0.6, width: 0.8 },
  horse: { category: 'person', spoken: 'Horse', height: 1.6, width: 2.0 },

  bicycle: { category: 'vehicle', spoken: 'Bicycle', height: 1.1, width: 1.7 },
  motorcycle: { category: 'vehicle', spoken: 'Motorcycle', height: 1.2, width: 2.0 },
  car: { category: 'vehicle', spoken: 'Car', height: 1.5, width: 1.8 },
  bus: { category: 'vehicle', spoken: 'Bus', height: 3.0, width: 2.5 },
  truck: { category: 'vehicle', spoken: 'Truck', height: 3.0, width: 2.5 },
  train: { category: 'vehicle', spoken: 'Train', height: 3.8, width: 3.0 },

  chair: { category: 'static', spoken: 'Chair', height: 0.9, width: 0.5 },
  bench: { category: 'static', spoken: 'Bench', height: 0.85, width: 1.5 },
  'potted plant': { category: 'static', spoken: 'Plant', height: 0.8, width: 0.5 },
  'stop sign': { category: 'static', spoken: 'Sign', height: 0.75, width: 0.75 },
  'fire hydrant': { category: 'static', spoken: 'Hydrant', height: 0.8, width: 0.4 },
  'parking meter': { category: 'static', spoken: 'Post', height: 1.3, width: 0.3 },
  'traffic light': { category: 'static', spoken: 'Traffic light', height: 0.9, width: 0.35 },
  'dining table': { category: 'static', spoken: 'Table', height: 0.75, width: 1.2 },
  couch: { category: 'static', spoken: 'Sofa', height: 0.85, width: 2.0 },
  bed: { category: 'static', spoken: 'Bed', height: 0.6, width: 1.6 },
  toilet: { category: 'static', spoken: 'Toilet', height: 0.75, width: 0.4 },
  suitcase: { category: 'static', spoken: 'Suitcase', height: 0.65, width: 0.45 },
  refrigerator: { category: 'static', spoken: 'Fridge', height: 1.8, width: 0.8 },
  tv: { category: 'static', spoken: 'Screen', height: 0.6, width: 1.0 },
};

export function classInfo(label: string): ClassInfo | undefined {
  return CLASS_INFO[label.toLowerCase()];
}

/** Lower number = more important. Blocked path and guide sit above these. */
export const CATEGORY_PRIORITY: Record<Category, number> = { vehicle: 0, person: 1, static: 2 };

/** COCO-80 label order used by YOLO-family ONNX exports. */
export const COCO80 = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat',
  'traffic light', 'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog',
  'horse', 'sheep', 'cow', 'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella',
  'handbag', 'tie', 'suitcase', 'frisbee', 'skis', 'snowboard', 'sports ball', 'kite',
  'baseball bat', 'baseball glove', 'skateboard', 'surfboard', 'tennis racket', 'bottle',
  'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple', 'sandwich', 'orange',
  'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch', 'potted plant',
  'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors',
  'teddy bear', 'hair drier', 'toothbrush',
];

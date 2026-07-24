from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT / "eagle-plugin" / "engine"))

from plugin_engine import (
    detect_nvidia_gpu,
    infer_loaded,
    recommend_batch_for_memory,
)


class FakeResult:
    returncode = 0
    stdout = (
        "0, GPU-AAA, NVIDIA GeForce RTX 3060, 12288, 8192, 555.10\n"
        "1, GPU-BBB, NVIDIA GeForce RTX 3090, 24576, 22000, 555.10\n"
    )


class AdaptiveTagger:
    def predict_batch(self, images, _threshold, _char_threshold):
        if len(images) > 2:
            raise RuntimeError("CUDA out of memory")
        return [f"result-{image}" for image in images]

    def predict(self, image, _threshold, _char_threshold):
        return f"result-{image}"


class GpuAdaptationTests(unittest.TestCase):
    def test_memory_recommendations_are_conservative(self):
        self.assertEqual(recommend_batch_for_memory(5 * 1024), 1)
        self.assertEqual(recommend_batch_for_memory(8 * 1024), 2)
        self.assertEqual(recommend_batch_for_memory(12 * 1024), 4)
        self.assertEqual(recommend_batch_for_memory(20 * 1024), 8)

    def test_detector_respects_visible_gpu(self):
        with patch.object(subprocess, "run", return_value=FakeResult()), patch.dict(
            "os.environ", {"CUDA_VISIBLE_DEVICES": "1"}
        ):
            gpu = detect_nvidia_gpu()
        self.assertEqual(gpu["name"], "NVIDIA GeForce RTX 3090")
        self.assertEqual(gpu["memory_free_mb"], 22000)
        self.assertEqual(gpu["recommended_batch"], 8)
        self.assertEqual(gpu["gpu_count"], 2)

    def test_batch_inference_recursively_falls_back(self):
        loaded = [({"id": str(index)}, index) for index in range(8)]
        results, safe_batch, errors = infer_loaded(AdaptiveTagger(), loaded, 0.35, 0.75)
        self.assertEqual(results, [f"result-{index}" for index in range(8)])
        self.assertEqual(safe_batch, 2)
        self.assertTrue(any("out of memory" in str(error) for error in errors))


if __name__ == "__main__":
    unittest.main()

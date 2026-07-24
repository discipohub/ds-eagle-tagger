"""Hidden inference worker used by the Eagle window plugin.

The process reads one JSON request from stdin and writes newline-delimited JSON
events to stdout. Human-readable diagnostics go to stderr so the plugin can
show them without corrupting the event stream.
"""
import contextlib
import csv
import io
import json
import math
import os
import subprocess
import sys
import time
import traceback
from pathlib import Path

from PIL import Image, ImageOps

from tagger import (
    build_tags,
    filter_graphic_false_positives,
    image_has_transparency,
    load_config,
    validate_config,
)
from wd14 import WD14Tagger, _pick_providers, model_cache_dir


def emit(event_type, **payload):
    sys.__stdout__.write(
        json.dumps({"type": event_type, **payload}, ensure_ascii=False) + "\n"
    )
    sys.__stdout__.flush()


def emit_model_download(**payload):
    emit("model_download", **payload)


def recommend_batch_for_memory(free_memory_mb):
    free = int(free_memory_mb or 0)
    if free >= 18 * 1024:
        return 8
    if free >= 10 * 1024:
        return 4
    if free >= 6 * 1024:
        return 2
    return 1


def detect_nvidia_gpu():
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=index,uuid,name,memory.total,memory.free,driver_version",
                "--format=csv,noheader,nounits",
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=8,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0:
            return None
        rows = list(csv.reader(io.StringIO(result.stdout)))
        gpus = []
        for row in rows:
            if len(row) < 6:
                continue
            gpus.append(
                {
                    "index": int(row[0].strip()),
                    "uuid": row[1].strip(),
                    "name": row[2].strip(),
                    "memory_total_mb": int(float(row[3].strip())),
                    "memory_free_mb": int(float(row[4].strip())),
                    "driver_version": row[5].strip(),
                }
            )
        if not gpus:
            return None
        visible = os.environ.get("CUDA_VISIBLE_DEVICES", "").split(",")[0].strip()
        selected = None
        if visible:
            if visible.isdigit():
                selected = next(
                    (gpu for gpu in gpus if gpu["index"] == int(visible)),
                    None,
                )
            else:
                selected = next((gpu for gpu in gpus if gpu["uuid"] == visible), None)
        selected = selected or gpus[0]
        selected["recommended_batch"] = recommend_batch_for_memory(
            selected["memory_free_mb"]
        )
        selected["gpu_count"] = len(gpus)
        return selected
    except Exception as error:
        print(f"GPU 信息检测失败：{error}", file=sys.stderr, flush=True)
        return None


def emit_probe():
    cfg = load_config()
    validate_config(cfg)
    with contextlib.redirect_stdout(sys.stderr):
        providers = _pick_providers()
    gpu = detect_nvidia_gpu() if "CUDAExecutionProvider" in providers else None
    cache = model_cache_dir(
        cfg["model_repo"],
        cfg.get("model_revision", "main"),
        base_dir=Path(__file__).parent / "models",
    )
    legacy_cache = Path(__file__).parent / "models" / cfg["model_repo"].split("/")[-1]
    emit(
        "probe",
        ok=True,
        provider=providers[0] if providers else "Unavailable",
        providers=providers,
        gpu=gpu,
        # If nvidia-smi is unavailable, prefer a conservative public default
        # instead of assuming the development machine's configured batch.
        recommended_batch=(gpu or {}).get("recommended_batch", 2),
        batch_size=cfg["batch_size"],
        model_ready=(cache / "model.onnx").exists() or (legacy_cache / "model.onnx").exists(),
    )


def load_request():
    raw = sys.stdin.buffer.read()
    if not raw:
        raise ValueError("没有收到插件任务")
    request = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(request, dict):
        raise ValueError("插件任务格式无效")
    return request


def load_images(item_batch):
    loaded = []
    failures = []
    for item in item_batch:
        try:
            path = Path(item["path"])
            if not path.is_file():
                raise FileNotFoundError(path)
            with Image.open(path) as source:
                image = ImageOps.exif_transpose(source).copy()
            loaded.append((item, image))
        except Exception as exc:
            failures.append((item, str(exc)))
    return loaded, failures


def _looks_like_memory_error(error):
    message = str(error).lower()
    return any(
        marker in message
        for marker in (
            "out of memory",
            "cuda_error_out_of_memory",
            "cudnn_status_alloc_failed",
            "failed to allocate",
            "allocation failed",
            "allocate memory",
            "memory limit",
        )
    )


def _supported_batch_at_or_below(value):
    for candidate in (8, 4, 2, 1):
        if candidate <= max(1, int(value)):
            return candidate
    return 1


def infer_loaded(tagger, loaded, threshold, char_threshold):
    try:
        results = tagger.predict_batch(
            [image for _, image in loaded], threshold, char_threshold
        )
        return results, None, []
    except Exception as batch_error:
        print(
            f"批量推理失败，正在自动降低 Batch：{batch_error}",
            file=sys.stderr,
            flush=True,
        )
        if len(loaded) <= 1:
            try:
                result = tagger.predict(loaded[0][1], threshold, char_threshold)
            except Exception as exc:
                result = exc
            return [result], 1, [batch_error]
        midpoint = max(1, len(loaded) // 2)
        left_results, left_safe, left_errors = infer_loaded(
            tagger, loaded[:midpoint], threshold, char_threshold
        )
        right_results, right_safe, right_errors = infer_loaded(
            tagger, loaded[midpoint:], threshold, char_threshold
        )
        successful_size = max(
            left_safe or len(loaded[:midpoint]),
            right_safe or len(loaded[midpoint:]),
        )
        return (
            left_results + right_results,
            _supported_batch_at_or_below(successful_size),
            [batch_error, *left_errors, *right_errors],
        )


def run_task(request):
    cfg = load_config()
    settings = request.get("settings") or {}
    for key in (
        "batch_size",
        "general_threshold",
        "character_threshold",
        "max_tags",
        "include_rating",
        "filter_graphic_person_tags",
    ):
        if key in settings:
            cfg[key] = settings[key]
    validate_config(cfg)
    if cfg["batch_size"] > 64:
        raise ValueError("batch_size 不能大于 64")
    if not 0 <= float(cfg["general_threshold"]) <= 1:
        raise ValueError("general_threshold 必须在 0 到 1 之间")
    if not 0 <= float(cfg["character_threshold"]) <= 1:
        raise ValueError("character_threshold 必须在 0 到 1 之间")

    items = request.get("items") or []
    if not isinstance(items, list) or not items:
        raise ValueError("没有需要处理的图片")
    for item in items:
        if not isinstance(item, dict) or not all(
            item.get(key) for key in ("id", "path")
        ):
            raise ValueError("图片任务缺少 ID 或文件路径")

    emit("status", stage="loading", message="正在加载 WD14 模型…", total=len(items))
    started = time.time()
    with contextlib.redirect_stdout(sys.stderr):
        tagger = WD14Tagger(
            cfg["model_repo"],
            mirrors=cfg["model_mirrors"],
            revision=cfg.get("model_revision", "main"),
            hashes=cfg.get("model_hashes"),
            sizes=cfg.get("model_sizes"),
            progress_callback=emit_model_download,
        )
    emit(
        "ready",
        provider=tagger.provider,
        batch_size=cfg["batch_size"],
        load_seconds=round(time.time() - started, 2),
    )

    completed = 0
    succeeded = 0
    failed = 0
    infer_started = time.time()
    runtime_batch = int(cfg["batch_size"])
    position = 0
    batch_index = 0
    while position < len(items):
        batch_index += 1
        item_batch = items[position : position + runtime_batch]
        batch_total = batch_index - 1 + math.ceil(
            (len(items) - position) / runtime_batch
        )
        emit(
            "batch_start",
            batch_index=batch_index,
            batch_total=batch_total,
            name=item_batch[0].get("name", "") if item_batch else "",
            completed=completed,
            total=len(items),
        )
        loaded, load_failures = load_images(item_batch)
        for item, error in load_failures:
            completed += 1
            failed += 1
            emit(
                "item_error",
                id=item.get("id"),
                name=item.get("name", ""),
                error=error,
                completed=completed,
                total=len(items),
            )

        if not loaded:
            position += len(item_batch)
            continue
        results, fallback_batch, fallback_errors = infer_loaded(
            tagger,
            loaded,
            float(cfg["general_threshold"]),
            float(cfg["character_threshold"]),
        )
        if fallback_batch and fallback_batch < runtime_batch:
            previous_batch = runtime_batch
            runtime_batch = fallback_batch
            memory_related = any(_looks_like_memory_error(error) for error in fallback_errors)
            emit(
                "batch_adjusted",
                from_batch=previous_batch,
                to_batch=runtime_batch,
                reason="oom" if memory_related else "batch_error",
                message=(
                    f"显存不足，Batch 已自动从 {previous_batch} 降至 {runtime_batch}"
                    if memory_related
                    else f"批量推理异常，Batch 已自动从 {previous_batch} 降至 {runtime_batch}"
                ),
            )
        for (item, image), result in zip(loaded, results):
            completed += 1
            if isinstance(result, Exception):
                image.close()
                failed += 1
                emit(
                    "item_error",
                    id=item["id"],
                    name=item.get("name", ""),
                    error=str(result),
                    completed=completed,
                    total=len(items),
                )
                continue

            general, characters, rating = result
            general, characters, filtered_tags = filter_graphic_false_positives(
                item.get("name", ""),
                image.size,
                general,
                characters,
                image_has_transparency(image),
                bool(cfg["filter_graphic_person_tags"]),
            )
            image.close()
            tags = build_tags(
                general,
                characters,
                rating,
                int(cfg["max_tags"]),
                bool(cfg["include_rating"]),
            )
            succeeded += 1
            elapsed = max(time.time() - infer_started, 0.001)
            rate = completed / elapsed
            emit(
                "item_result",
                id=item["id"],
                name=item.get("name", ""),
                tags=tags,
                filtered_tags=filtered_tags,
                completed=completed,
                total=len(items),
                rate=round(rate, 2),
                eta_seconds=round((len(items) - completed) / rate) if rate else 0,
            )
        position += len(item_batch)

    emit(
        "done",
        total=len(items),
        succeeded=succeeded,
        failed=failed,
        elapsed_seconds=round(time.time() - infer_started, 2),
        effective_batch_size=runtime_batch,
    )


def main():
    try:
        if "--probe" in sys.argv:
            emit_probe()
        else:
            run_task(load_request())
        return 0
    except Exception as exc:
        traceback.print_exc(file=sys.stderr)
        emit("fatal", error=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

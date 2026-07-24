"""Print the highest WD14 general-tag scores for one local image."""

import sys
from pathlib import Path

engine_root = Path(sys.argv[2])
sys.path.insert(0, str(engine_root))

from PIL import Image  # noqa: E402
from wd14 import WD14Tagger  # noqa: E402
from tagger import load_config  # noqa: E402

config = load_config()
tagger = WD14Tagger(
    config["model_repo"],
    mirrors=config["model_mirrors"],
    revision=config.get("model_revision", "main"),
    hashes=config.get("model_hashes"),
    sizes=config.get("model_sizes"),
)
with Image.open(sys.argv[1]) as image:
    general, _characters, rating = tagger.predict(image.copy(), 0.0, 1.0)

print(f"provider={tagger.provider} rating={rating}")
for name, score in general[:50]:
    print(f"{score:.4f}\t{name}")

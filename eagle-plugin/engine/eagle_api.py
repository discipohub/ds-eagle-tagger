"""Eagle 本地 API 客户端（http://localhost:41595）"""
import os
from urllib.parse import unquote

import requests


class EagleError(RuntimeError):
    pass


class EagleClient:
    def __init__(self, base_url="http://localhost:41595", token=None, timeout=30):
        self.base = base_url.rstrip("/")
        self.token = token
        self.timeout = timeout

    def _get(self, path, **params):
        if self.token:
            params["token"] = self.token
        r = requests.get(self.base + path, params=params, timeout=self.timeout)
        r.raise_for_status()
        data = r.json()
        if data.get("status") != "success":
            raise EagleError(f"GET {path} failed: {data}")
        return data.get("data")

    def _post(self, path, payload):
        if self.token:
            payload = {**payload, "token": self.token}
        r = requests.post(self.base + path, json=payload, timeout=self.timeout)
        r.raise_for_status()
        data = r.json()
        if data.get("status") != "success":
            raise EagleError(f"POST {path} failed: {data}")
        return data.get("data")

    def app_info(self):
        return self._get("/api/application/info")

    def library_info(self):
        return self._get("/api/library/info")

    def list_folders(self):
        return self._get("/api/folder/list") or []

    def list_items(self, limit=200, offset=0, folder=None):
        params = {"limit": limit, "offset": offset}
        if folder:
            params["folders"] = folder
        return self._get("/api/item/list", **params) or []

    def iter_items(self, folder=None, page_size=200):
        """遍历库中所有条目（分页）。offset 以页为单位。"""
        page = 0
        while True:
            batch = self.list_items(limit=page_size, offset=page, folder=folder)
            if not batch:
                return
            yield from batch
            if len(batch) < page_size:
                return
            page += 1

    def thumbnail_path(self, item_id):
        p = self._get("/api/item/thumbnail", id=item_id)
        return unquote(p)

    def item_file_path(self, item):
        """定位条目的图片文件：优先原图，找不到再用缩略图。"""
        thumb = self.thumbnail_path(item["id"])
        folder = os.path.dirname(thumb)
        name, ext = item.get("name", ""), item.get("ext", "")
        original = os.path.join(folder, f"{name}.{ext}")
        if os.path.exists(original):
            return original
        if os.path.exists(thumb):
            return thumb
        # 兜底：目录里找同扩展名文件
        if os.path.isdir(folder):
            for f in os.listdir(folder):
                if f.lower().endswith("." + ext.lower()):
                    return os.path.join(folder, f)
        raise FileNotFoundError(f"item {item['id']}: file not found in {folder}")

    def update_tags(self, item_id, tags):
        return self._post("/api/item/update", {"id": item_id, "tags": tags})

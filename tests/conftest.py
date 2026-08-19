"""pytest 共享配置。

- 在 import app 之前设置 CLIPBENCH_TEST=1，
  避免测试进程加载/写入真实的 tasks.json（见 app.py 中对应守卫）；
- 每个测试自动使用隔离的临时目录（uploads / outputs / tasks.json），互不干扰。
"""
import os
import sys

# 保证能 import 项目根目录下的 app 模块
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("CLIPBENCH_TEST", "1")

import pytest

import app as app_module
from app import TASKS


@pytest.fixture(autouse=True)
def isolate(tmp_path, monkeypatch):
    """每个测试使用独立的临时上传/输出/任务文件目录，并清空内存任务表。"""
    uploads = tmp_path / "uploads"
    outputs = tmp_path / "outputs"
    uploads.mkdir()
    outputs.mkdir()
    monkeypatch.setattr(app_module, "UPLOAD_DIR", uploads)
    monkeypatch.setattr(app_module, "OUTPUT_DIR", outputs)
    monkeypatch.setattr(app_module, "TASKS_FILE", tmp_path / "tasks.json")
    TASKS.clear()
    yield
    TASKS.clear()

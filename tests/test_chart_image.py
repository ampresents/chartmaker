# チャート画像が正解画像 (tests/golden/*.png) と 1 画素も違わないことを確かめる
# 描画を意図して変えたときは、画像を目で確かめてから正解画像を作り直す:
#   UPDATE_GOLDEN=1 .venv/Scripts/python -m pytest tests/test_chart_image.py
import os
import shutil

import cv2
import numpy as np
import pytest

from conftest import FIXTURES, ROOT
from ChartLib import generate_chart

GOLDEN = os.path.join(ROOT, "tests", "golden")


@pytest.mark.parametrize("name", ["full", "plain"])
def test_chart_matches_golden(name, config, tmp_path):
    actual_path = str(tmp_path / (name + ".png"))
    generate_chart(os.path.join(FIXTURES, "plan_{}.txt".format(name)), actual_path, config)
    golden_path = os.path.join(GOLDEN, name + ".png")

    if os.environ.get("UPDATE_GOLDEN"):
        shutil.copyfile(actual_path, golden_path)
        pytest.skip("正解画像を作り直しました: " + golden_path)

    actual = cv2.imread(actual_path)
    golden = cv2.imread(golden_path)
    assert golden is not None, "正解画像がありません。UPDATE_GOLDEN=1 で作ってください"
    assert actual.shape == golden.shape
    diff = np.any(actual != golden, axis=2)
    if diff.any():
        # どこが違うかを目で確かめられるよう、違う画素を赤く塗った画像を残す
        marked = actual.copy()
        marked[diff] = (0, 0, 255)
        cv2.imwrite(str(tmp_path / (name + "_diff.png")), marked)
        ys, xs = np.nonzero(diff)
        pytest.fail("{} 画素が違います (x {}-{}, y {}-{})。実際の画像と差分: {}".format(
            int(diff.sum()), xs.min(), xs.max(), ys.min(), ys.max(), tmp_path))

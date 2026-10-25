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


def test_chart_rate_two_decimals(config, tmp_path):
    # エディタの書き出しのように割合を小数 2 桁で書いても (省略 → 1.00、0.5 → 0.50)、画像は 1 画素も変わらない
    out = []
    with open(os.path.join(FIXTURES, "plan_full.txt"), encoding="utf-8") as f:
        for line in f.read().splitlines():
            if not line.startswith(("#", "::")):
                items = line.split(",")
                if len(items) == 4:
                    items.append("1.00")
                elif len(items) == 5:
                    items[4] = "{:.2f}".format(float(items[4]))
                line = ",".join(items)
            out.append(line)
    assert any(line.endswith(",1.00") for line in out)
    assert any(line.endswith(",0.50") for line in out) and any(line.endswith(",0.60") for line in out)
    src = tmp_path / "plan.txt"
    src.write_text("\n".join(out) + "\n", encoding="utf-8")
    actual_path = str(tmp_path / "full.png")
    generate_chart(str(src), actual_path, config)
    actual = cv2.imread(actual_path)
    golden = cv2.imread(os.path.join(GOLDEN, "full.png"))
    assert actual.shape == golden.shape
    assert not np.any(actual != golden)

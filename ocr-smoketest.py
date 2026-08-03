#!/usr/bin/env python3
# Unlimited-OCR smoke test — run ONE PDF through baidu/Unlimited-OCR on a GPU box and
# print the parsed output + timing. A spike to see if the output is clean/structured
# before we bother wiring it into the footnote benchmark. NOT production.
#
# Setup (once, on the GPU container):
#   # If torch is already installed and matches the box's CUDA, DO NOT reinstall it.
#   pip install "transformers==4.57.1" pymupdf pillow accelerate
#   # torch/torchvision only if missing: pip install torch==2.10.0 torchvision==0.25.0
#
# Run:
#   python ocr-smoketest.py /path/to/some.pdf
#
# If HuggingFace is unreachable from the cluster: on a machine WITH internet run
#   huggingface-cli download baidu/Unlimited-OCR --local-dir ./Unlimited-OCR
# scp that folder over, and set MODEL below to the local path.
import sys, os, time, glob

MODEL = os.environ.get("OCR_MODEL", "baidu/Unlimited-OCR")  # or a local dir path
PDF = sys.argv[1] if len(sys.argv) > 1 else "doc.pdf"
OUT = "ocr_out"
DPI = 200
os.makedirs(OUT, exist_ok=True)

# 1) PDF -> page PNGs (the model takes image files; render with PyMuPDF)
import fitz  # pymupdf
t0 = time.time()
doc = fitz.open(PDF)
pages = []
for i, page in enumerate(doc):
    fp = os.path.join(OUT, f"page_{i+1:03d}.png")
    page.get_pixmap(dpi=DPI).save(fp)
    pages.append(fp)
print(f"[render] {len(pages)} pages @ {DPI}dpi in {time.time()-t0:.1f}s", flush=True)

# 2) load model — container has only 4GB RAM, so stream weights straight to the GPU
#    (device_map) instead of materializing ~6.5GB in CPU RAM first. Fallback: plain load.
import torch
from transformers import AutoModel, AutoTokenizer
t1 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL, trust_remote_code=True)
try:
    model = AutoModel.from_pretrained(
        MODEL, trust_remote_code=True, use_safetensors=True,
        torch_dtype=torch.bfloat16, device_map={"": "cuda:0"},  # needs `accelerate`
    ).eval()
    print("[load] streamed weights directly to GPU (low CPU RAM path)", flush=True)
except Exception as e:
    print(f"[load] device_map path failed ({type(e).__name__}: {e}); plain load…", flush=True)
    model = AutoModel.from_pretrained(
        MODEL, trust_remote_code=True, use_safetensors=True, torch_dtype=torch.bfloat16
    ).eval().cuda()
print(f"[load] model ready in {time.time()-t1:.1f}s "
      f"(GPU mem {torch.cuda.memory_allocated()/1e9:.1f}GB)", flush=True)

# 3) inference (multi-page)
t2 = time.time()
ret = model.infer_multi(
    tok,
    prompt="<image>Multi page parsing.",
    image_files=pages,
    output_path=OUT,
    image_size=1024,
    max_length=32768,
    no_repeat_ngram_size=35, ngram_window=1024,
    save_results=True,
)
dt = time.time() - t2
print(f"[infer] {len(pages)} pages in {dt:.1f}s ({dt/max(len(pages),1):.1f}s/page)", flush=True)

# 4) show whatever it produced — return value and/or files written to OUT
print(f"\n===== RETURN VALUE (type: {type(ret).__name__}) =====")
print(str(ret)[:4000])
print(f"\n===== TEXT/MD FILES WRITTEN TO {OUT}/ =====")
for f in sorted(glob.glob(os.path.join(OUT, "*"))):
    if f.lower().endswith((".md", ".mmd", ".txt", ".json")):
        print(f"\n--- {os.path.basename(f)} ---")
        print(open(f, encoding="utf-8", errors="replace").read()[:4000])

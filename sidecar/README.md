# Transcription sidecar

Sous Chef transcribes with WhisperX, which runs in Python. The edit server
starts `transcribe.py` as a separate process when a transcript is needed.

## Setup (once, needs an NVIDIA card for usable speed)

```bash
uv venv --python 3.11 <somewhere>/sous-sidecar
uv pip install --python <somewhere>/sous-sidecar/Scripts/python.exe whisperx
uv pip install --python <somewhere>/sous-sidecar/Scripts/python.exe \
  --index https://download.pytorch.org/whl/cu128 --reinstall \
  torch==2.8.0 torchaudio==2.8.0 torchvision==0.23.0
```

Then tell Sous Chef where it is, in `%LOCALAPPDATA%\sous-chef\config.json`:

```json
{ "python": "<somewhere>/sous-sidecar/Scripts/python.exe", "hfHome": "<folder for model downloads>" }
```

The first transcription downloads about 3 GB of models into `hfHome`.

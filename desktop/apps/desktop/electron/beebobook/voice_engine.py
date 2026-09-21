"""Beebo's local Kokoro adapter. Models stay in the user's Hugging Face cache.

Modified by Beebo: one shared model, language-correct English pipelines and a
bounded CPU thread count. Uses installed Kokoro; does not bundle that dependency.
"""
import os

_pipelines = {}

def pipeline_for(voice):
    language = 'b' if voice.startswith('b') else 'a'
    if language not in _pipelines:
        import torch
        from kokoro import KPipeline
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        model = next(iter(_pipelines.values())).model if _pipelines else True
        _pipelines[language] = KPipeline(lang_code=language, model=model, repo_id='hexgrad/Kokoro-82M')
    return _pipelines[language]

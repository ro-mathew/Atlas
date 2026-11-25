"""Incremental codec playback ported from the standalone local voice implementation."""
import numpy as np

class StreamingCodec:
    """Preserve causal caches/ISTFT overlap; float32 codec arithmetic avoids BF16 chunk drift.

    KV storage is bounded by the reply token limit. Sliding attention masking is
    still applied by the model; full KV storage avoids rotating-cache chunk seams.
    """
    def __init__(self, codec):
        import mlx.core as mx
        from mlx_vlm.models.cache import ArraysCache, KVCache
        self.mx=mx; self.codec=codec
        self.decoder=next(module for module in codec.decoder.children().values() if hasattr(module, "layers"))
        self.cache=[ArraysCache(size=1) if layer.layer_type=='conv' else KVCache() for layer in self.decoder.layers]
        cfg=codec.config
        self.hop=cfg.stft_hop_length; self.nfft=cfg.stft_n_fft
        self.trim=(self.nfft-self.hop)//2
        self.window=np.asarray(codec.decoder.istft.window,dtype=np.float32)
        self.tail=np.zeros(self.nfft-self.hop,np.float32)
        self.envelope=np.zeros_like(self.tail)
        self.skip=self.trim; self.frames=0
    def push(self, codes):
        mx=self.mx; c=self.codec; self.frames+=1
        x=c.from_quantizer(c.quantizer(codes[None,:,None]))
        hidden=self.decoder(cache=self.cache,input_embeddings=mx.repeat(x,c.config.stft_frame_stack,axis=1))
        mag,angle=mx.split(c.decoder.lin(hidden).astype(mx.float32),2,axis=-1)
        spec=mx.exp(mag)*(mx.cos(angle)+1j*mx.sin(angle))
        frames=np.asarray(mx.fft.irfft(spec,n=self.nfft,axis=-1)[0],dtype=np.float32)*self.window
        n=len(frames); count=n*self.hop
        out=np.zeros(count+len(self.tail),np.float32); env=np.zeros_like(out)
        out[:len(self.tail)]+=self.tail; env[:len(self.envelope)]+=self.envelope
        for i,frame in enumerate(frames):
            start=i*self.hop
            out[start:start+self.nfft]+=frame
            env[start:start+self.nfft]+=self.window*self.window
        self.tail=out[count:]; self.envelope=env[count:]
        stable=out[:count]/np.maximum(env[:count],1e-12)
        skip=min(self.skip,len(stable)); self.skip-=skip
        return stable[skip:]
    def finish(self):
        if not self.frames: return np.array([],np.float32)
        n=len(self.tail)-self.trim
        out=self.tail[:n]/np.maximum(self.envelope[:n],1e-12)
        skip=min(self.skip,len(out)); self.skip-=skip
        return out[skip:]

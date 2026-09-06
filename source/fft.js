__M["src/fft.js"]=(()=>{

/** In-place radix-2 inverse FFT. The only normalization is 1/N in each 1D pass. */
class FFT {
  constructor(n) {
    if (n < 2 || n & (n - 1))
      throw new RangeError("FFT size must be a power of two");
    this.n = n;
    this.reverse = new Uint32Array(n);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    let bits = Math.log2(n);
    for (let i = 0; i < n; i++) {
      let x = i,
        r = 0;
      for (let j = 0; j < bits; j++) {
        r = (r << 1) | (x & 1);
        x >>>= 1;
      }
      this.reverse[i] = r;
    }
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  transform(re, im, offset = 0, stride = 1, inverse = true) {
    const n = this.n,
      rev = this.reverse;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const a = offset + i * stride,
          b = offset + j * stride;
        let x = re[a];
        re[a] = re[b];
        re[b] = x;
        x = im[a];
        im[a] = im[b];
        im[b] = x;
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2,
        step = n / size;
      for (let base = 0; base < n; base += size)
        for (let j = 0; j < half; j++) {
          const tw = j * step,
            wr = this.cos[tw],
            wi = this.sin[tw] * (inverse ? 1 : -1),
            a = offset + (base + j) * stride,
            b = a + half * stride,
            tr = wr * re[b] - wi * im[b],
            ti = wr * im[b] + wi * re[b];
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
    }
    if (inverse)
      for (let j = 0; j < n; j++) {
        const i = offset + j * stride;
        re[i] /= n;
        im[i] /= n;
      }
  }
  transform2D(re, im, inverse = true) {
    const n = this.n;
    if (re.length !== n * n || im.length !== n * n)
      throw new RangeError("Wrong FFT buffer dimensions");
    for (let y = 0; y < n; y++) this.transform(re, im, y * n, 1, inverse);
    for (let x = 0; x < n; x++) this.transform(re, im, x, n, inverse);
  }
}



return {FFT};
})();

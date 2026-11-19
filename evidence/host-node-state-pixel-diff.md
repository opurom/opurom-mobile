# Host ABI pixel-diff evidence (NOT device evidence)
platform: build-host software raster
device: N/A (adb not installed; xcrun no available/attached iOS device)
ir: todo.opuir.json (shipped mobile asset)
viewport: 320x240 RGBA8
digest: FNV-1a 64-bit hex over RGBA bytes

| step | ABI event | frame digest | changed pixels vs baseline |
| --- | --- | --- | --- |
| 0 | initial | d20f0ad6cd30ee71 | 0 |
| 1 | set_node_states([10, hover]) | c129029a38b2c55f | 1798 |
| 2 | set_node_states([10, focus]) | f36111db305bb621 | - |
| 3 | set_node_states(null, 0) | d20f0ad6cd30ee71 | 0 |
| 4 | set_press(10, 3900, down) | cae7f389c21ade42 | 1939 |
| 5 | set_press(10, 4000, confirm) | cae7f389c21ade42 | - |
| 6 | set_press(0, 0, clear) | d20f0ad6cd30ee71 | 0 |

replay: all six digests reproduced byte-for-byte on a fresh OpuRenderer.

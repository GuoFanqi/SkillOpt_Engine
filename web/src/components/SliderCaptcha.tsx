import { useState, useRef, useCallback } from 'react'
import { ArrowRight, RefreshCw } from 'lucide-react'

interface Props {
  onVerify: () => void
  onReset: () => void
  disabled?: boolean
}

export default function SliderCaptcha({ onVerify, onReset, disabled }: Props) {
  const [sliderPos, setSliderPos] = useState(0)
  const [verified, setVerified] = useState(false)
  const [dragging, setDragging] = useState(false)
  const trackRef = useRef<HTMLDivElement>(null)

  const doReset = useCallback(() => {
    setSliderPos(0)
    setVerified(false)
    onReset()
  }, [onReset])

  const handleStart = useCallback(() => {
    if (verified || disabled) return
    setDragging(true)
  }, [verified, disabled])

  const handleMove = useCallback((clientX: number) => {
    if (!dragging || verified || !trackRef.current) return
    const rect = trackRef.current.getBoundingClientRect()
    const x = Math.max(0, Math.min(clientX - rect.left, rect.width - 48))
    setSliderPos(x)
  }, [dragging, verified])

  const handleEnd = useCallback(() => {
    if (!dragging || verified || !trackRef.current) return
    const width = trackRef.current.getBoundingClientRect().width
    if (sliderPos >= width - 50) {
      setSliderPos(width - 48)
      setVerified(true)
      onVerify()
    } else {
      setSliderPos(0)
      onReset()
    }
    setDragging(false)
  }, [dragging, verified, sliderPos, onVerify, onReset])

  return (
    <div className={`rounded-xl p-1 relative select-none ${disabled ? 'bg-gray-200' : 'bg-gray-100'}`} style={{ touchAction: disabled ? 'auto' : 'none' }}>
      {!verified && !disabled && (
        <div
          className="absolute inset-0 rounded-xl overflow-hidden"
          style={{
            width: sliderPos > 0 ? `${sliderPos + 48}px` : '48px',
            background: 'linear-gradient(135deg, #6366f1, #818cf8)',
            transition: dragging ? 'none' : 'width 0.3s',
          }}
        />
      )}
      <div
        ref={trackRef}
        className="relative w-full h-10 rounded-xl flex items-center justify-center"
        onClick={verified ? doReset : undefined}
        onMouseDown={handleStart}
        onMouseMove={(e) => handleMove(e.clientX)}
        onMouseUp={handleEnd}
        onMouseLeave={handleEnd}
        onTouchStart={handleStart}
        onTouchMove={(e) => handleMove(e.touches[0].clientX)}
        onTouchEnd={handleEnd}
      >
        {/* Track text */}
        {!verified && !disabled && (
          <span
            className="text-xs text-gray-400 absolute pointer-events-none"
            style={{ opacity: sliderPos > 20 ? 0 : 1, transition: 'opacity 0.2s' }}
          >
            滑动验证
          </span>
        )}
        {disabled && !verified && (
          <span className="text-xs text-gray-400 absolute pointer-events-none">请先输入手机号</span>
        )}
        {/* Slider knob */}
        <div
          className={`absolute left-0 top-0 w-12 h-10 rounded-xl flex items-center justify-center shadow-sm transition-colors ${verified ? 'bg-green-500 text-white cursor-pointer hover:bg-red-400' : disabled ? 'bg-gray-300 text-gray-400 cursor-not-allowed' : 'bg-white text-indigo-500 cursor-grab active:cursor-grabbing shadow-md'}`}
          style={{ transform: `translateX(${sliderPos}px)`, transition: dragging ? 'none' : 'transform 0.3s' }}
        >
          {verified ? (
            <RefreshCw className="w-4 h-4" />
          ) : (
            <ArrowRight className="w-4 h-4" />
          )}
        </div>
        {/* Verified state - click to reset */}
        {verified && (
          <span className="text-xs text-green-600 pl-12 cursor-pointer" onClick={doReset}>
            点击重新验证
          </span>
        )}
      </div>
    </div>
  )
}

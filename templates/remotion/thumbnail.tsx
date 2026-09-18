import React, { useLayoutEffect, useRef, useState } from "react";
import {
  AbsoluteFill,
  Img,
  Still,
  cancelRender,
  continueRender,
  delayRender,
  registerRoot,
} from "remotion";

type Props = {
  background: string;
  headline: string;
  brand: {
    background: string;
    foreground: string;
    accent: string;
    fontFamily: string;
  };
};
const Thumbnail: React.FC<Props> = ({ background, headline, brand }) => {
  const text = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(104);
  const [handle] = useState(() => delayRender("Fit thumbnail headline"));
  useLayoutEffect(() => {
    let active = true;
    void document.fonts.ready.then(() => {
      if (!active || !text.current) return;
      // Measure line boxes, not scrollHeight: font descenders can extend a few
      // pixels below their line box even when exactly two lines fit.
      const fits =
        text.current.clientHeight <= Math.ceil(size * 1.08 * 2) + 1 &&
        text.current.scrollWidth <= text.current.clientWidth;
      if (fits) continueRender(handle);
      else if (size > 60) setSize(size - 2);
      else cancelRender(new Error("THUMBNAIL_HEADLINE_OVERFLOW"));
    });
    return () => {
      active = false;
    };
  }, [handle, size]);
  return (
    <AbsoluteFill
      style={{
        background: brand.background,
        color: brand.foreground,
        fontFamily: brand.fontFamily,
      }}
    >
      {background && (
        <Img
          src={background}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center",
          }}
        />
      )}
      <AbsoluteFill
        style={{
          background: `linear-gradient(90deg, ${brand.background} 2%, ${brand.background}ee 35%, ${brand.background}88 57%, transparent 83%)`,
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 80,
          top: 156,
          width: 90,
          height: 9,
          background: brand.accent,
        }}
      />
      <div
        ref={text}
        style={{
          position: "absolute",
          left: 80,
          top: 208,
          width: 760,
          fontSize: size,
          fontWeight: 800,
          lineHeight: 1.08,
          whiteSpace: "pre-wrap",
          textShadow: "0 2px 12px #00000066",
        }}
      >
        {headline}
      </div>
    </AbsoluteFill>
  );
};
registerRoot(() => (
  <Still
    id="YTAIStudioThumbnail"
    component={Thumbnail}
    width={1280}
    height={720}
    defaultProps={{
      background: "",
      headline: "TWO SERVERS.\nONE FAILURE.",
      brand: {
        background: "#101b29",
        foreground: "#f2f4ed",
        accent: "#c8ef80",
        fontFamily: "Helvetica Neue",
      },
    }}
  />
));

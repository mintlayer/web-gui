import { QRCodeSVG } from 'qrcode.react';

interface Props {
  uri: string;
}

export default function TotpQrCode({ uri }: Props) {
  if (!uri) return null;
  return (
    <div className="flex flex-col items-center gap-3 p-4 bg-white rounded-xl w-fit mx-auto">
      <QRCodeSVG value={uri} size={200} />
    </div>
  );
}

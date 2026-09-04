declare module 'tz-lookup' {
  /** 由座標回傳 IANA 時區名稱；海域回傳 Etc/GMT±N。 */
  function tzlookup(lat: number, lng: number): string;
  export default tzlookup;
}

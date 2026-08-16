/**
 * Weather, as far as a railway is concerned: how far you can see.
 *
 * Not a simulation of weather — there is no precipitation, no wind, nothing
 * accumulates. What is modelled is the one consequence that changes how the job
 * is done, which is **sighting distance**. A signal you cannot see yet is a
 * signal you are approaching on the strength of the last one, and that is the
 * whole of why 105 and 115 are written in terms of what can be seen.
 *
 * It also decides how far out the view can usefully be zoomed: showing a crew
 * two kilometres of railway in fog would be showing them something they do not
 * have.
 */
export type Weather = 'clear' | 'rain' | 'snow' | 'fog' | 'night';

/** How far you can see, metres. */
export const VISIBILITY: Record<Weather, number> = {
  clear: 3000,
  rain: 1400,
  snow: 800,
  fog: 350,
  // Not weather, but it belongs on the same scale: at night you see as far as
  // the headlight reaches and no further.
  night: 500,
};

export const WEATHER_LABEL: Record<Weather, string> = {
  clear: 'Clear',
  rain: 'Rain',
  snow: 'Snow',
  fog: 'Fog',
  night: 'Night',
};

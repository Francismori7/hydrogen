import {TemplateOptions} from 'types';

export default function ({storeDomain, storefrontToken}: TemplateOptions) {
  return `

export default {
  storeDomain: '${storeDomain}',
  storefrontToken: '${storefrontToken}',
  storefrontApiVersion: "unstable",
};

`;
}

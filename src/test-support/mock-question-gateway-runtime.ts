export const questionGatewayRuntime = {
  registerChannelDelivery(_input: {
    questionId: string;
    deliveryId: string;
    finalize: (statusLine: string) => void;
  }): void {},
};
